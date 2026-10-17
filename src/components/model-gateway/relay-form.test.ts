import { describe, expect, it } from "vitest";
import { prepareRelaySettingsUpdate } from "./relay-form";

const base = { baseUrl: " https://sub.shaozhuangai.com/v1 ", apiKey: "", clearKey: false, models: [] };

describe("中转站管理表单", () => {
  it("自动汇率只读，保存模型或凭据不把每日缓存汇率写回手动配置", () => {
    for (const rate of ["6.704588", "", "invalid"]) {
      const result = prepareRelaySettingsUpdate({ ...base, apiKey: "test-only-placeholder", usdCnyRate: rate, usdCnyAutomatic: true });
      expect(result.error).toBeUndefined();
      expect(result.input).toMatchObject({ apiKey: "test-only-placeholder" });
      expect(result.input).not.toHaveProperty("usdCnyRate");
    }
  });

  it("手动模式保留有效汇率、留空禁用和非法汇率拒绝的语义", () => {
    expect(prepareRelaySettingsUpdate({ ...base, usdCnyRate: "7.123456", usdCnyAutomatic: false }).input?.usdCnyRate).toBe(7.123456);
    expect(prepareRelaySettingsUpdate({ ...base, usdCnyRate: "" }).input?.usdCnyRate).toBeNull();
    expect(prepareRelaySettingsUpdate({ ...base, usdCnyRate: "invalid" }).error).toContain("美元汇率");
  });

  it("留空保留服务端 Key，不把空凭据提交为替换值", () => {
    const result = prepareRelaySettingsUpdate({ ...base, apiKey: "  " });
    expect(result.input).toEqual({ baseUrl: "https://sub.shaozhuangai.com/v1", clearKey: false, models: [] });
    expect(result.input).not.toHaveProperty("apiKey");
  });

  it("店铺配置验证始终返回明确错误，同时留空保留历史 Key", () => {
    const row = { shopName: "西西礼", purpose: "default" as const, apiKey: "", clear: false };
    expect(prepareRelaySettingsUpdate({ ...base, shopKeys: [{ ...row, shopName: " " }] }).error).toBe("店铺名称不能为空。");
    expect(prepareRelaySettingsUpdate({ ...base, shopKeys: [row, row] }).error).toContain("同一用途重复");
    const result = prepareRelaySettingsUpdate({ ...base, shopKeys: [row] });
    expect(result.input?.shopKeys).toEqual([{ shopName: "西西礼", purpose: "default" }]);
  });

  it("显式清除 Key 时不发送表单里残留的新凭据", () => {
    const result = prepareRelaySettingsUpdate({ ...base, clearKey: true, apiKey: "new-secret" });
    expect(result.input).toMatchObject({ clearKey: true });
    expect(result.input).not.toHaveProperty("apiKey");
  });

  it("拒绝启用未分类模型和未定费率的视频模型", () => {
    expect(prepareRelaySettingsUpdate({ ...base, models: [{ id: "new", label: "new", upstreamModel: "new", kind: "unknown", enabled: true }] }).error).toContain("先选择模型类型");
    expect(prepareRelaySettingsUpdate({ ...base, models: [{ id: "video", label: "video", upstreamModel: "video", kind: "video", enabled: true }] }).error).toContain("大于 0 的整数分");
    expect(prepareRelaySettingsUpdate({ ...base, models: [{ id: "video", label: "video", upstreamModel: "video", kind: "video", enabled: true, videoCents: 80.5 }] }).error).toContain("整数分");
  });

  it("待分类模型可以保存为停用，明确登记和计费的视频模型才可启用", () => {
    const result = prepareRelaySettingsUpdate({ ...base, models: [
      { id: "new", label: "", upstreamModel: "new-upstream", kind: "unknown", enabled: false },
      { id: "video", label: "商品视频", upstreamModel: "actual-upstream-video", kind: "video", enabled: true, videoCents: 80 }
    ] });
    expect(result.error).toBeUndefined();
    expect(result.input?.models[0]).toMatchObject({ label: "new", enabled: false });
    expect(result.input?.models[1]).toMatchObject({ upstreamModel: "actual-upstream-video", videoCents: 80 });
  });

  it("拒绝重复别名及零价聊天模型", () => {
    const model = { id: "chat", label: "chat", upstreamModel: "chat", kind: "chat" as const, enabled: true, promptCentsPer1K: 2, completionCentsPer1K: 3 };
    expect(prepareRelaySettingsUpdate({ ...base, models: [model, { ...model, id: " chat " }] }).error).toContain("重复");
    expect(prepareRelaySettingsUpdate({ ...base, models: [{ ...model, promptCentsPer1K: 0 }] }).error).toContain("均需大于 0");
  });

  it("图片按整数分计价，聊天每千 Token 费率可用小数", () => {
    expect(prepareRelaySettingsUpdate({ ...base, models: [{ id: "image", label: "图片", upstreamModel: "image", kind: "image", enabled: true, imageCents: 30.5 }] }).error).toContain("整数分");
    expect(prepareRelaySettingsUpdate({ ...base, models: [{ id: "chat", label: "聊天", upstreamModel: "chat", kind: "chat", enabled: true, promptCentsPer1K: 0.5, completionCentsPer1K: 1.5 }] }).error).toBeUndefined();
  });
  it("店铺校验失败时返回明确错误，不提交部分店铺凭据", () => {
    const shop = { shopName: "店铺甲", purpose: "default" as const, apiKey: "", clear: false };
    const empty = prepareRelaySettingsUpdate({ ...base, shopKeys: [shop, { ...shop, shopName: "  " }] });
    expect(empty).toEqual({ error: "店铺名称不能为空。" });
    const duplicate = prepareRelaySettingsUpdate({ ...base, shopKeys: [shop, { ...shop, shopName: " 店铺甲 " }] });
    expect(duplicate).toEqual({ error: "店铺「店铺甲」的同一用途重复。" });
  });

  it("按用途分别保存店铺，留空保留凭据，清除时不提交残留 Key", () => {
    const result = prepareRelaySettingsUpdate({ ...base, shopKeys: [
      { shopName: " 店铺甲 ", purpose: "default", apiKey: "  ", clear: false },
      { shopName: "店铺甲", purpose: "image", apiKey: "new-secret", clear: true }
    ] });
    expect(result.input?.shopKeys).toEqual([
      { shopName: "店铺甲", purpose: "default" },
      { shopName: "店铺甲", purpose: "image", clear: true }
    ]);
    expect(prepareRelaySettingsUpdate({ ...base, shopKeys: [] }).input?.shopKeys).toEqual([]);
  });
});
