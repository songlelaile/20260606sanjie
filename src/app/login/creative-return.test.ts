import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as React from "react";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeAuthReturnPath } from "@/lib/auth-return-path";

const state = { cursor: 0, values: new Map<number, unknown>(), search: new URLSearchParams() };
const requireDependency = createRequire(import.meta.url);
const pageModule = { exports: {} as { default: typeof import("./page")["default"] } };
const compiled = ts.transpileModule(readFileSync(new URL("./page.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;
new Function("require", "exports", compiled)((id: string) => {
  if (id === "react") return {
    ...React,
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!state.values.has(index)) state.values.set(index, initial);
      return [state.values.get(index), (next: unknown) => state.values.set(index, next)];
    },
    useEffect: () => {},
    useRef: (initial: unknown) => ({ current: initial })
  };
  if (id === "next/navigation") return { useSearchParams: () => state.search };
  if (id === "@/lib/auth-return-path") return { safeAuthReturnPath };
  return requireDependency(id);
}, pageModule.exports);

type Element = React.ReactElement<Record<string, unknown>>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as React.ReactNode)];
}
async function submitLogin() {
  state.cursor = 0;
  const suspense = pageModule.exports.default();
  const view = suspense.props.children as Element;
  const tree = (view.type as () => React.ReactNode)();
  const form = elements(tree).find((element) => element.type === "form");
  if (!form) throw new Error("缺少登录表单");
  await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: vi.fn() });
}
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const IMAGE = "/dashboards/operating-network";
beforeEach(() => {
  state.cursor = 0; state.values.clear(); state.search = new URLSearchParams();
  vi.stubGlobal("window", { location: { replace: vi.fn() } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ data: { home: "/tools" } })));
});

describe("real login component creative return submission", () => {
  it.each([IMAGE, ...["detail", "sku", "viral", "viral-case", "viral-style", "viral-scene", "clothing", "buyer", "refinement"].map((id) => `${IMAGE}?surface=${id}`), `${IMAGE}/video`])(
    "rebuilds the document at the requested module %s after successful login", async (route) => {
      state.search.set("returnTo", route);
      await submitLogin();
      expect(window.location.replace).toHaveBeenCalledOnce();
      expect(window.location.replace).toHaveBeenCalledWith(route);
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/auth/login");
    }
  );

  it("keeps the existing shared report return destination", async () => {
    const report = `/shared/dmp-reports/${"a".repeat(64)}`;
    state.search.set("returnTo", report);
    await submitLogin();
    expect(window.location.replace).toHaveBeenCalledWith(report);
  });

  it.each([undefined, "https://evil.example", "//evil.example", `${IMAGE}?apiKey=secret`, `${IMAGE}?surface=unknown`, `${IMAGE}/video#fragment`])(
    "uses the server role home for missing or invalid destination %s", async (route) => {
      if (route !== undefined) state.search.set("returnTo", route);
      await submitLogin();
      expect(window.location.replace).toHaveBeenCalledWith("/tools");
    }
  );

  it("does not navigate on a failed login", async () => {
    state.search.set("returnTo", `${IMAGE}?surface=buyer`);
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: "账号或密码错误" }, 401));
    await submitLogin();
    expect(window.location.replace).not.toHaveBeenCalled();
  });
});
