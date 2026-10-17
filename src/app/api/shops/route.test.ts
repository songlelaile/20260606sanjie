import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveShopCookie: vi.fn(),
  getShopSwitcherData: vi.fn(),
  createShop: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-server", () => ({ getActiveShopCookie: mocks.getActiveShopCookie }));
vi.mock("@/lib/store/runtime-store", () => ({
  getShopSwitcherData: mocks.getShopSwitcherData,
  createShop: mocks.createShop
}));

import { GET } from "./route";

const DATA = {
  shops: [{ id: "shop-a", name: "店铺 A" }, { id: "shop-b", name: "店铺 B" }],
  activeShopId: "shop-a",
  limit: 3,
  canCreate: true,
  isAdmin: false
};

describe("GET /api/shops active-shop evidence", () => {
  beforeEach(() => {
    mocks.getActiveShopCookie.mockReset();
    mocks.getShopSwitcherData.mockReset();
    mocks.getShopSwitcherData.mockResolvedValue(DATA);
  });

  it("marks the activity shop explicit only when the non-empty cookie uniquely matches the tenant shop", async () => {
    mocks.getActiveShopCookie.mockResolvedValue("shop-a");
    await expect((await GET()).json()).resolves.toMatchObject({
      data: { activeShopId: "shop-a", activeShopExplicit: true }
    });
  });

  it.each([null, "", "foreign-shop", "shop-b"])(
    "does not treat runtime first-shop fallback or an invalid cookie (%s) as explicit",
    async (cookieShopId) => {
      mocks.getActiveShopCookie.mockResolvedValue(cookieShopId);
      await expect((await GET()).json()).resolves.toMatchObject({
        data: { activeShopId: "shop-a", activeShopExplicit: false }
      });
    }
  );
});
