import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ receive: vi.fn() }));
vi.mock("@/lib/model-gateway/scan-payment", () => ({ receiveScanNotification: mocks.receive }));
import { POST as alipay } from "./alipay/notify/route";
import { POST as wechat } from "./wechat/notify/route";
describe("payment notification acknowledgment", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.receive.mockResolvedValue(undefined); });
  it("acknowledges only after verified settlement and binds the URL's channel", async () => {
    const request = new Request("http://localhost/notify", { method: "POST", body: "signed-provider-body" });
    expect(await (await alipay(request)).text()).toBe("success");
    expect(mocks.receive).toHaveBeenLastCalledWith("alipay", request);
    expect((await wechat(request)).status).toBe(204); expect(mocks.receive).toHaveBeenLastCalledWith("wechat", request);
  });
  it("does not acknowledge failed signatures or failed database settlement", async () => {
    mocks.receive.mockRejectedValue(new Error("secret upstream details"));
    const request = new Request("http://localhost/notify", { method: "POST" });
    const ali = await alipay(request); expect(ali.status).toBe(400); expect(await ali.text()).toBe("failure");
    const wx = await wechat(request); expect(wx.status).toBe(400); expect(await wx.text()).not.toContain("secret");
  });
});
