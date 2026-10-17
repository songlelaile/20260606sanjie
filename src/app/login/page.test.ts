import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeDmpReportReturnPath } from "@/lib/dmp-report-share-path";

const state = {
  cursor: 0, values: new Map<number, unknown>(), search: new URLSearchParams(),
  effects: [] as Array<() => void>, pending: { current: false }
};

// Compile only this production component in memory; Next's JSX configuration
// and the repository's normal test configuration remain unchanged.
const requireDependency = createRequire(import.meta.url);
const compilerOptions = { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true };
// Keep the real visual child in this markup fixture; CSS has no effect on its text.
const brandModule = { exports: {} as typeof import("@/components/BrandIdentity") };
const brandSource = readFileSync(new URL("../../components/BrandIdentity.tsx", import.meta.url), "utf8");
const brandCompiled = ts.transpileModule(brandSource, { compilerOptions }).outputText;
new Function("require", "exports", brandCompiled)((id: string) => {
  if (id === "./BrandIdentity.module.css") return {};
  return requireDependency(id);
}, brandModule.exports);
const pageModule = { exports: {} as { default: typeof import("./page")["default"] } };
const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions
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
    useEffect: (callback: () => void) => { state.effects.push(callback); },
    useRef: () => state.pending
  };
  if (id === "next/navigation") return { useSearchParams: () => state.search };
  if (id === "@/lib/dmp-report-share-path") return { safeDmpReportReturnPath };
  if (id === "@/components/BrandIdentity") return brandModule.exports;
  return requireDependency(id);
}, pageModule.exports);

type Element = React.ReactElement<Record<string, unknown>>;

function render(tab: "login" | "register" | "invite" = "login") {
  state.values.set(0, tab);
  state.cursor = 0;
  state.effects = [];
  const suspense = pageModule.exports.default();
  const view = suspense.props.children as Element;
  return (view.type as () => React.ReactNode)();
}

function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as React.ReactNode)];
}

async function submit(tree: React.ReactNode) {
  const form = elements(tree).find((element) => element.type === "form");
  if (!form) throw new Error("缺少注册或登录表单");
  await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: vi.fn() });
  // The registration form intentionally uses a void event handler.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  state.cursor = 0;
  state.values.clear();
  state.search = new URLSearchParams();
  state.effects = [];
  state.pending.current = false;
  vi.stubGlobal("window", { location: { replace: vi.fn() } });
  vi.stubGlobal("fetch", vi.fn());
});

describe("login and registration presentation", () => {
  it("makes independent registration, payment and separate DMP authorization clear", () => {
    const markup = renderToStaticMarkup(render("register"));
    expect(markup).toContain("独立工作区");
    expect(markup).toContain("非受邀客户须充值开通作图与视频工作台");
    expect(markup).toContain("达摩盘工具需单独授权");
    expect(markup).not.toContain("手机号注册即可上手");
    expect(markup).not.toContain("直接开通");
    expect(markup).toContain("注册独立工作区");
  });

  it("keeps invitation access distinct from self registration and applies server limits", () => {
    const tree = render("invite");
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain("受邀客户注册后可访问作图与视频工作台");
    expect(markup).toContain("充值后开通");
    const inputs = elements(tree).filter((element) => element.type === "input");
    expect(inputs.find((input) => input.props.autoComplete === "name")?.props.maxLength).toBe(50);
    expect(inputs.find((input) => input.props.autoComplete === "new-password")?.props).toMatchObject({ minLength: 6, maxLength: 128, required: true });
    expect(inputs.find((input) => input.props.autoComplete === "off")?.props).toMatchObject({ minLength: 6, maxLength: 32, pattern: "[A-Za-z0-9]{6,32}", required: true });
  });

  it("opens and prefills invitation registration from the generated registration link", () => {
    state.search.set("invite", "welcome");
    render();
    state.effects[0]();
    expect(state.values.get(0)).toBe("invite");
    expect(state.values.get(8)).toBe("WELCOME");
    const markup = renderToStaticMarkup(render("invite"));
    expect(markup).toContain('value="WELCOME"');
  });
});

describe("registration and login requests", () => {
  it("never silently registers without an invite when the invitation field is blank", async () => {
    state.values.set(8, "   ");
    await submit(render("invite"));
    expect(fetch).not.toHaveBeenCalled();
    expect(state.values.get(9)).toContain("请输入邀请码");
    expect(state.values.get(10)).toBe(false);
  });

  it("excludes stale invitation text from self registration", async () => {
    state.values.set(4, "新客户");
    state.values.set(5, "13800000001");
    state.values.set(6, "valid-password");
    state.values.set(8, "STALECODE");
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { home: "/tools/creative" } }));
    await submit(render("register"));
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(request).toEqual({ name: "新客户", username: "13800000001", password: "valid-password" });
    expect(window.location.replace).toHaveBeenCalledWith("/tools/creative");
    expect(state.values.get(10)).toBe(false);
  });

  it("normalizes invitation codes and restores submission after a network error", async () => {
    state.values.set(8, " welcome ");
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    await submit(render("invite"));
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(request.inviteCode).toBe("WELCOME");
    expect(state.values.get(9)).toContain("网络连接失败");
    expect(state.values.get(10)).toBe(false);
    expect(state.pending.current).toBe(false);
  });

  it("prevents concurrent form submissions", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const tree = render("register");
    await submit(tree);
    await submit(tree);
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(jsonResponse({ error: "该手机号已注册" }, 400));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(state.values.get(9)).toBe("该手机号已注册");
    expect(state.values.get(10)).toBe(false);
  });

  it("preserves the permitted shared report path and rejects external login returns", async () => {
    const path = `/shared/dmp-reports/${"a".repeat(64)}`;
    state.search.set("returnTo", path);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { home: "/tools" } }));
    await submit(render());
    expect(window.location.replace).toHaveBeenLastCalledWith(path);
    state.search.set("returnTo", "https://outside.example/");
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { home: "/tools" } }));
    await submit(render());
    expect(window.location.replace).toHaveBeenLastCalledWith("/tools");
  });
});
