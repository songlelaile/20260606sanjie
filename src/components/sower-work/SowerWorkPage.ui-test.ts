import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSowerWorkAccess: vi.fn(), redirect: vi.fn(), headers: vi.fn() }));
vi.mock("@/lib/sower-work-access", () => ({ getSowerWorkAccess: mocks.getSowerWorkAccess }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/components/sower-work/SowerWorkStudio", () => ({
  SowerWorkStudio: () => createElement("div", { "data-sower-work-studio": "true" }, "网页版工作台")
}));

import SowerWorkPage from "@/app/sower-work/page";

describe("Sower Work page database gate", () => {
  beforeEach(() => {
    mocks.getSowerWorkAccess.mockReset();
    mocks.redirect.mockReset();
    mocks.headers.mockResolvedValue(new Headers({ host: "shaozhuangai.com" }));
    mocks.redirect.mockImplementation((destination: string) => { throw new Error(`redirect:${destination}`); });
  });

  it("moves the www entrance to the canonical host before rendering its iframe", async () => {
    mocks.headers.mockResolvedValue(new Headers({ host: "www.shaozhuangai.com" }));
    await expect(SowerWorkPage()).rejects.toThrow("redirect:https://shaozhuangai.com/sower-work");
    expect(mocks.getSowerWorkAccess).not.toHaveBeenCalled();
  });

  it("renders the web studio for a database-validated administrator", async () => {
    mocks.getSowerWorkAccess.mockResolvedValue({ allowed: true, user: { id: "admin-1" } });
    const html = renderToStaticMarkup(await SowerWorkPage());
    expect(html).toContain('data-sower-work-studio="true"');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("redirects invalid or absent sessions to login", async () => {
    mocks.getSowerWorkAccess.mockResolvedValue({ allowed: false, status: 401, message: "会话失效" });
    await expect(SowerWorkPage()).rejects.toThrow("redirect:/login");
  });

  it("redirects tenant users to image creation", async () => {
    mocks.getSowerWorkAccess.mockResolvedValue({ allowed: false, status: 403, message: "管理账号专用" });
    await expect(SowerWorkPage()).rejects.toThrow("redirect:/dashboards/operating-network");
  });

  it("shows unavailable authorization without loading the studio if the database fails", async () => {
    mocks.getSowerWorkAccess.mockResolvedValue({ allowed: false, status: 503, message: "授权查询暂不可用，请稍后重试" });
    const html = renderToStaticMarkup(await SowerWorkPage());
    expect(html).toContain("授权查询暂不可用，请稍后重试");
    expect(html).not.toContain("data-sower-work-studio");
  });
});
