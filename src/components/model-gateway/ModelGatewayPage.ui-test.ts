import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModelsPage from "@/app/models/page";
import { GET as overviewGET } from "@/app/api/model-gateway/overview/route";

const mocks = vi.hoisted(() => ({ user: vi.fn(), overview: vi.fn(), models: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/model-gateway/store", () => ({ getGatewayOverview: mocks.overview }));
vi.mock("@/lib/model-gateway/runtime-catalog", () => ({ listAvailableGatewayModels: mocks.models }));
vi.mock("@/lib/model-gateway/catalog", () => ({ GATEWAY_PLANS: [], gatewayProviderLabel: () => "少壮中转站" }));

const overview = {
  wallet: { balanceCents: 1000, monthlyQuotaCents: 0, planCode: "starter", planName: "体验版", periodEnd: "2026-10-01" },
  keys: [], orders: [], usages: []
};

describe("模型网关服务端数据边界", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: "tenant-1", role: "admin", authRole: "tenant", status: "active" });
    mocks.overview.mockResolvedValue(overview);
    mocks.models.mockResolvedValue([]);
  });

  it("店铺管理角色 admin 的普通租户不获得中转站管理入口", async () => {
    const html = renderToStaticMarkup(await ModelsPage({ searchParams: Promise.resolve({}) }));
    expect(html).not.toContain("relay-settings-heading");
    expect(html).toContain("选择套餐");
  });

  it("仅 active 的 authRole admin 获得全局管理入口", async () => {
    mocks.user.mockResolvedValue({ id: "admin-1", role: "owner", authRole: "admin", status: "active" });
    expect(renderToStaticMarkup(await ModelsPage({ searchParams: Promise.resolve({ tab: "api" }) }))).toContain("relay-settings-heading");
    mocks.user.mockResolvedValue({ id: "admin-1", role: "admin", authRole: "admin", status: "disabled" });
    expect(renderToStaticMarkup(await ModelsPage({ searchParams: Promise.resolve({ tab: "api" }) }))).not.toContain("relay-settings-heading");
  });

  it("API 菜单深链单独打开接入页，其余参数保持积分页", async () => {
    const api = renderToStaticMarkup(await ModelsPage({ searchParams: Promise.resolve({ tab: "api" }) }));
    expect(api).toContain("API 接入与调用记录");
    expect(api).not.toContain("选择套餐");
    expect(api).not.toContain("relay-settings-heading");
    for (const tab of [undefined, "other", ["api"]]) {
      const html = renderToStaticMarkup(await ModelsPage({ searchParams: Promise.resolve({ tab }) }));
      expect(html).toContain("选择套餐");
      expect(html).not.toContain("API 接入与调用记录");
    }
  });

  it("概览只公开模型调用字段，不输出上游地址或凭据", async () => {
    mocks.models.mockResolvedValue([{ id: "public-image", label: "图片", provider: "shaozhuang", kind: "image", endpoint: "images.generations", upstreamModel: "private-upstream-name", defaultBaseUrl: "https://private.example/v1", apiKey: "private-upstream-secret", apiKeyEnv: "PRIVATE_KEY_NAME" }]);
    const response = await overviewGET();
    const json = await response.json();
    expect(json.data.models).toEqual([{ id: "public-image", label: "图片", provider: "shaozhuang", providerLabel: "少壮中转站", kind: "image", endpoint: "images.generations" }]);
    expect(JSON.stringify(json)).not.toContain("private-");
    expect(JSON.stringify(json)).not.toContain("PRIVATE_KEY_NAME");
  });

  it("模型配置读取失败保留账户页面与概览，并隐藏内部错误", async () => {
    mocks.models.mockRejectedValue(new Error("/private/config/path secret-key"));
    const html = renderToStaticMarkup(await ModelsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("模型目录暂不可用");
    expect(html).toContain("可用积分");
    expect(html).not.toContain("secret-key");
    const response = await overviewGET();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.models).toEqual([]);
    expect(json.data.wallet.balanceCents).toBe(1000);
    expect(json.data.modelCatalogError).toContain("模型目录暂不可用");
    expect(JSON.stringify(json)).not.toContain("/private");
  });

  it("未登录不读取账户或模型目录", async () => {
    mocks.user.mockResolvedValue(null);
    expect(await ModelsPage({ searchParams: Promise.resolve({}) })).toBeNull();
    expect((await overviewGET()).status).toBe(401);
    expect(mocks.overview).not.toHaveBeenCalled();
    expect(mocks.models).not.toHaveBeenCalled();
  });
});
