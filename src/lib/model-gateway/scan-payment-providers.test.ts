import { createCipheriv, generateKeyPairSync, sign, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScanPayment, getAlipayPageCheckout, getScanProviderAvailability, queryScanPayment, verifyScanNotification } from "./scan-payment-providers";
vi.mock("server-only", () => ({}));

// Synthetic keys only. No test contacts a payment provider or reads production credentials.
const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = platform.publicKey.export({ type: "spki", format: "pem" }).toString();
const orderId = "scan_test_123456";
const appId = "2021000000000001";
const sellerId = "2088000000000001";
const wxAppId = "wx1234567890abcdef";
const mchId = "1900000001";
const publicKeyId = "PUB_KEY_ID_3000000001";
const apiKey = "0123456789abcdef0123456789abcdef";
const fixtureEnv = {
  ALIPAY_APP_ID: appId, ALIPAY_SELLER_ID: sellerId, ALIPAY_PRIVATE_KEY: privatePem, ALIPAY_PUBLIC_KEY: publicPem,
  ALIPAY_PAYMENT_PRODUCT: "",
  WECHAT_PAY_APP_ID: wxAppId, WECHAT_PAY_MCH_ID: mchId, WECHAT_PAY_PRIVATE_KEY: privatePem,
  WECHAT_PAY_SERIAL_NO: "112233445566778899AABBCCDDEEFF0011223344", WECHAT_PAY_API_V3_KEY: apiKey,
  WECHAT_PAY_PUBLIC_KEY: publicPem, WECHAT_PAY_PUBLIC_KEY_ID: publicKeyId, SCAN_PAYMENT_NOTIFY_BASE_URL: "https://shaozhuangai.com"
};
const fetchMock = vi.fn<typeof fetch>();
const createInput = () => ({ orderId, description: "三阶引擎积分充值", amountCents: 30000, expiresAt: new Date(Date.now() + 15 * 60_000) });

function signedAlipay(data: Record<string, unknown>, operation = "query", raw?: string) {
  const fragment = raw ?? JSON.stringify(data);
  const signature = sign("RSA-SHA256", Buffer.from(fragment), platform.privateKey).toString("base64");
  return new Response(`{"alipay_trade_${operation}_response":${fragment},"sign":${JSON.stringify(signature)}}`, { headers: { "content-type": "application/json" } });
}

function wxHeaders(text: string, overrides: Record<string, string> = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "provider-test-nonce";
  return {
    "content-type": "application/json", "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce, "wechatpay-serial": publicKeyId,
    "wechatpay-signature": sign("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${text}\n`), platform.privateKey).toString("base64"), ...overrides
  };
}

function signedWechat(data: Record<string, unknown>, status = 200) {
  const text = JSON.stringify(data);
  return new Response(text, { status, headers: wxHeaders(text) });
}

function aliTrade(overrides: Record<string, unknown> = {}) {
  return { code: "10000", out_trade_no: orderId, trade_no: "202610021234567890", trade_status: "TRADE_SUCCESS", total_amount: "300.00", ...overrides };
}

function wxTrade(overrides: Record<string, unknown> = {}) {
  return { appid: wxAppId, mchid: mchId, out_trade_no: orderId, transaction_id: "4200000123456789012345", trade_type: "NATIVE", trade_state: "SUCCESS", amount: { total: 30000, currency: "CNY" }, ...overrides };
}

function aliNotify(overrides: Record<string, string> = {}, tamper = "") {
  const data: Record<string, string> = { app_id: appId, seller_id: sellerId, out_trade_no: orderId, trade_no: "202610021234567890", trade_status: "TRADE_SUCCESS", total_amount: "300.00", sign_type: "RSA2", subject: "充值 + 300 & 元", ...overrides };
  const canonical = Object.keys(data).filter(key => key !== "sign_type" && data[key] !== "").sort().map(key => `${key}=${data[key]}`).join("&");
  data.sign = sign("RSA-SHA256", Buffer.from(canonical), platform.privateKey).toString("base64");
  return new Request("https://shaozhuangai.com/api/payments/alipay/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams(data).toString() + tamper });
}

function wxNotify(trade: Record<string, unknown> = wxTrade(), options: { headers?: Record<string, string>; badCipher?: boolean; event?: string } = {}) {
  const nonce = "0123456789ab";
  const associated = "transaction";
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(apiKey), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associated));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(trade)), cipher.final(), cipher.getAuthTag()]);
  if (options.badCipher) encrypted[0] ^= 1;
  const text = JSON.stringify({ id: "notification-test", event_type: options.event ?? "TRANSACTION.SUCCESS", resource_type: "encrypt-resource", resource: { algorithm: "AEAD_AES_256_GCM", nonce, associated_data: associated, ciphertext: encrypted.toString("base64") } });
  return new Request("https://shaozhuangai.com/api/payments/wechat/notify", { method: "POST", headers: wxHeaders(text, options.headers), body: text });
}

beforeEach(() => {
  for (const [key, val] of Object.entries(fixtureEnv)) vi.stubEnv(key, val);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("scan payment configuration", () => {
  it("exposes only readiness booleans and fails closed without required credentials", async () => {
    expect(getScanProviderAvailability()).toEqual([{ provider: "alipay", available: true }, { provider: "wechat", available: true }]);
    vi.stubEnv("ALIPAY_SELLER_ID", "");
    vi.stubEnv("WECHAT_PAY_API_V3_KEY", "");
    expect(getScanProviderAvailability()).toEqual([{ provider: "alipay", available: false }, { provider: "wechat", available: false }]);
    await expect(createScanPayment({ provider: "alipay", ...createInput() })).rejects.toMatchObject({ code: "PAYMENT_PROVIDER_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects malformed keys and callback URLs without disclosing values", () => {
    vi.stubEnv("ALIPAY_PRIVATE_KEY", "secret-broken-key");
    vi.stubEnv("SCAN_PAYMENT_NOTIFY_BASE_URL", "http://localhost/");
    expect(getScanProviderAvailability().every(item => !item.available)).toBe(true);
  });
  it("rejects invalid amount, short order IDs and expiry before contacting any provider", async () => {
    for (const change of [{ amountCents: 0 }, { amountCents: 1.1 }, { orderId: "bad" }, { expiresAt: new Date(Date.now() - 1) }]) {
      await expect(createScanPayment({ provider: "wechat", ...createInput(), ...change })).rejects.toMatchObject({ code: "PAYMENT_ORDER_INVALID" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Alipay precreate and query", () => {
  it("signs the fixed official request and verifies the exact raw response bytes", async () => {
    const raw = `{\n "code" : "10000", "out_trade_no":"${orderId}", "qr_code":"https:\\/\\/qr.alipay.com\\/example", "extra": {"nested":[1,{"quoted":"}\\\""}]}\n}`;
    fetchMock.mockResolvedValue(signedAlipay({}, "precreate", raw));
    const input = createInput();
    expect(await createScanPayment({ provider: "alipay", ...input })).toEqual({ paymentUrl: "https://qr.alipay.com/example" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openapi.alipay.com/gateway.do");
    expect(init).toMatchObject({ redirect: "error", cache: "no-store", signal: expect.any(AbortSignal) });
    const parameters = Object.fromEntries(new URLSearchParams(String(init?.body)));
    const canonical = Object.keys(parameters).filter(key => key !== "sign").sort().map(key => `${key}=${parameters[key]}`).join("&");
    expect(verify("RSA-SHA256", Buffer.from(canonical), merchant.publicKey, Buffer.from(parameters.sign, "base64"))).toBe(true);
    expect(parameters.notify_url).toBe("https://shaozhuangai.com/api/payments/alipay/notify");
    expect(JSON.parse(parameters.biz_content)).toMatchObject({ out_trade_no: orderId, seller_id: sellerId, total_amount: "300.00" });
    expect(JSON.parse(parameters.biz_content).time_expire).toBe(new Date(input.expiresAt.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " "));
  });
  it("rejects unsigned or tampered provider responses", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ alipay_trade_query_response: aliTrade(), sign: "invalid" })));
    await expect(queryScanPayment("alipay", orderId)).rejects.toMatchObject({ code: "PAYMENT_SIGNATURE_INVALID" });
  });
  it("rejects duplicate response keys even with a valid signature over one value", async () => {
    const response = await signedAlipay(aliTrade()).text();
    fetchMock.mockResolvedValue(new Response(response.replace('{"alipay_trade_query_response":', '{"alipay_trade_query_response":{},"alipay_trade_query_response":')));
    await expect(queryScanPayment("alipay", orderId)).rejects.toThrow();
  });
  it.each(["300.00", 300, "0.29", 0.29])("parses a signed decimal amount %s without floating point rounding", async amount => {
    fetchMock.mockResolvedValue(signedAlipay(aliTrade({ total_amount: amount })));
    expect(await queryScanPayment("alipay", orderId)).toMatchObject({ amountCents: Number(amount) === 300 ? 30000 : 29, orderId, provider: "alipay" });
  });
  it.each(["0.001", "-1", "1e2", "0"]) ("rejects invalid signed amount %s", async amount => {
    fetchMock.mockResolvedValue(signedAlipay(aliTrade({ total_amount: amount })));
    await expect(queryScanPayment("alipay", orderId)).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_INVALID" });
  });
  it("returns null for signed unpaid and nonexistent orders", async () => {
    fetchMock.mockResolvedValueOnce(signedAlipay(aliTrade({ trade_status: "WAIT_BUYER_PAY" }))).mockResolvedValueOnce(signedAlipay({ code: "40004", sub_code: "ACQ.TRADE_NOT_EXIST" }));
    expect(await queryScanPayment("alipay", orderId)).toBeNull();
    expect(await queryScanPayment("alipay", orderId)).toBeNull();
  });
  it("rejects another order and foreign QR destinations even if provider-signed", async () => {
    fetchMock.mockResolvedValueOnce(signedAlipay(aliTrade({ out_trade_no: "another_order" }))).mockResolvedValueOnce(signedAlipay({ code: "10000", out_trade_no: orderId, qr_code: "https://evil.example/pay" }, "precreate"));
    await expect(queryScanPayment("alipay", orderId)).rejects.toMatchObject({ code: "PAYMENT_ORDER_MISMATCH" });
    await expect(createScanPayment({ provider: "alipay", ...createInput() })).rejects.toThrow();
  });
});

describe("Alipay desktop website payment", () => {
  beforeEach(() => vi.stubEnv("ALIPAY_PAYMENT_PRODUCT", "page_pay"));
  const pageView = (paymentUrl: string, input = createInput()) => getAlipayPageCheckout({ paymentUrl, ...input });
  function pageParameters(paymentUrl: string) {
    const url = new URL(paymentUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://openapi.alipay.com/gateway.do");
    const parameters = Object.fromEntries(url.searchParams);
    const canonical = Object.keys(parameters).filter(key => key !== "sign").sort().map(key => `${key}=${parameters[key]}`).join("&");
    expect(verify("RSA-SHA256", Buffer.from(canonical), merchant.publicKey, Buffer.from(parameters.sign, "base64"))).toBe(true);
    return parameters;
  }
  it("creates a signed fixed-width page-pay GET URL locally without calling precreate", async () => {
    const input = createInput();
    const { paymentUrl } = await createScanPayment({ provider: "alipay", ...input });
    const parameters = pageParameters(paymentUrl);
    expect(parameters).toMatchObject({ app_id: appId, method: "alipay.trade.page.pay", sign_type: "RSA2", notify_url: fixtureEnv.SCAN_PAYMENT_NOTIFY_BASE_URL + "/api/payments/alipay/notify" });
    expect(JSON.parse(parameters.biz_content)).toEqual({ out_trade_no: orderId, total_amount: "300.00", subject: input.description,
      time_expire: new Date(input.expiresAt.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " "),
      product_code: "FAST_INSTANT_TRADE_PAY", qr_pay_mode: "4", qrcode_width: 220 });
    expect(pageView(paymentUrl, input)?.cashierUrl).toBe(paymentUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("independently signs a stable full-page fallback for the same order and never mutates the saved URL", async () => {
    vi.useFakeTimers();
    const input = createInput();
    const { paymentUrl } = await createScanPayment({ provider: "alipay", ...input });
    const view = pageView(paymentUrl, input)!;
    const embedded = pageParameters(view.cashierUrl);
    const fallback = pageParameters(view.fallbackCashierUrl);
    expect(JSON.parse(fallback.biz_content)).toEqual({ ...JSON.parse(embedded.biz_content), qr_pay_mode: "2", qrcode_width: undefined });
    expect(fallback.sign).not.toBe(embedded.sign);
    expect(fallback.timestamp).toBe(embedded.timestamp);
    vi.advanceTimersByTime(10_000);
    expect(pageView(paymentUrl, input)).toEqual(view);
    // Switching the configured product does not break an already-issued pending page order.
    vi.stubEnv("ALIPAY_PAYMENT_PRODUCT", "precreate");
    expect(pageView(paymentUrl, input)).toEqual(view);
  });
  it.each(["wap_pay", "PAGE_PAY", "alipay.trade.page.pay"])("rejects unsupported configured product %s", async product => {
    vi.stubEnv("ALIPAY_PAYMENT_PRODUCT", product);
    expect(getScanProviderAvailability()[0].available).toBe(false);
    await expect(createScanPayment({ provider: "alipay", ...createInput() })).rejects.toMatchObject({ code: "PAYMENT_PROVIDER_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects saved URLs for a different order, amount or expiration", async () => {
    const input = createInput();
    const { paymentUrl } = await createScanPayment({ provider: "alipay", ...input });
    expect(pageView(paymentUrl, { ...input, orderId: "another_order" })).toBeNull();
    expect(pageView(paymentUrl, { ...input, amountCents: 1 })).toBeNull();
    expect(pageView(paymentUrl, { ...input, expiresAt: new Date(input.expiresAt.getTime() + 1000) })).toBeNull();
  });
  it("rejects lookalike hosts, credentials, fragments, duplicate fields and tampered signed parameters", async () => {
    const input = createInput();
    const { paymentUrl } = await createScanPayment({ provider: "alipay", ...input });
    const invalid = [paymentUrl.replace("https:", "http:"), paymentUrl.replace("openapi.alipay.com", "openapi.alipay.com.evil.example"),
      paymentUrl.replace("openapi.alipay.com", "user@openapi.alipay.com"), paymentUrl.replace("openapi.alipay.com", "openapi.alipay.com:8443"),
      paymentUrl.replace("/gateway.do?", "/elsewhere?"), paymentUrl + "#fragment", paymentUrl + "&app_id=" + appId,
      paymentUrl.replace("alipay.trade.page.pay", "alipay.trade.precreate"), paymentUrl + "&return_url=https%3A%2F%2Fevil.example"];
    for (const url of invalid) expect(pageView(url, input)).toBeNull();
    const tampered = new URL(paymentUrl);
    tampered.searchParams.set("biz_content", JSON.stringify({ ...JSON.parse(tampered.searchParams.get("biz_content")!), qr_pay_mode: "2" }));
    expect(pageView(tampered.toString(), input)).toBeNull();
    vi.stubEnv("ALIPAY_PRIVATE_KEY", platform.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    expect(pageView(paymentUrl, input)).toBeNull();
  });
  it("keeps a browser-not-yet-opened page order pending and uses the existing signed query and notify verification", async () => {
    fetchMock.mockResolvedValueOnce(signedAlipay({ code: "40004", sub_code: "ACQ.TRADE_NOT_EXIST" })).mockResolvedValueOnce(signedAlipay(aliTrade()));
    expect(await queryScanPayment("alipay", orderId)).toBeNull();
    expect(await queryScanPayment("alipay", orderId)).toMatchObject({ provider: "alipay", amountCents: 30000, orderId });
    expect(await verifyScanNotification("alipay", aliNotify())).toMatchObject({ provider: "alipay", amountCents: 30000, orderId });
    for (const [, init] of fetchMock.mock.calls) expect(new URLSearchParams(String(init?.body)).get("method")).toBe("alipay.trade.query");
  });
  it("accepts only the dedicated embed contract even if another flow has a valid merchant signature", async () => {
    const input = createInput();
    const { paymentUrl } = await createScanPayment({ provider: "alipay", ...input });
    const original = Object.fromEntries(new URL(paymentUrl).searchParams);
    const business = JSON.parse(original.biz_content);
    const changes: Record<string, string>[] = [
      { biz_content: JSON.stringify({ ...business, qr_pay_mode: "2" }) },
      { biz_content: JSON.stringify({ ...business, qrcode_width: 1 }) },
      { biz_content: JSON.stringify({ ...business, product_code: "QUICK_WAP_WAY" }) },
      { biz_content: original.biz_content.replace("{", '{"total_amount":"0.01",') },
      { notify_url: "https://evil.example/notify" }, { return_url: "https://evil.example" },
      { app_id: "2021000000000002" }
    ];
    for (const change of changes) {
      const parameters: Record<string, string> = { ...original, ...change };
      const canonical = Object.keys(parameters).filter(key => key !== "sign").sort().map(key => `${key}=${parameters[key]}`).join("&");
      parameters.sign = sign("RSA-SHA256", Buffer.from(canonical), merchant.privateKey).toString("base64");
      expect(pageView(`https://openapi.alipay.com/gateway.do?${new URLSearchParams(parameters)}`, input)).toBeNull();
    }
  });
});

describe("Alipay notifications", () => {
  it("verifies form values decoded exactly once including plus and ampersand", async () => {
    expect(await verifyScanNotification("alipay", aliNotify())).toEqual({ provider: "alipay", orderId, receipt: "202610021234567890", amountCents: 30000 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([{ app_id: "2021000000000002" }, { seller_id: "2088000000000002" }])("rejects another merchant identity", async overrides => {
    await expect(verifyScanNotification("alipay", aliNotify(overrides))).rejects.toMatchObject({ code: "PAYMENT_MERCHANT_MISMATCH" });
  });
  it("rejects repeated form fields and a non-RSA2 algorithm", async () => {
    await expect(verifyScanNotification("alipay", aliNotify({}, "&total_amount=0.01"))).rejects.toThrow();
    await expect(verifyScanNotification("alipay", aliNotify({ sign_type: "RSA" }))).rejects.toMatchObject({ code: "PAYMENT_SIGNATURE_INVALID" });
  });
  it("rejects an explicitly foreign currency", async () => {
    await expect(verifyScanNotification("alipay", aliNotify({ currency: "USD" }))).rejects.toMatchObject({ code: "PAYMENT_CURRENCY_INVALID" });
  });
  it("returns null for a valid non-success notification", async () => {
    expect(await verifyScanNotification("alipay", aliNotify({ trade_status: "TRADE_CLOSED" }))).toBeNull();
  });
});

describe("WeChat Native request and query", () => {
  it("accepts the current official Native code_url example with the /up path", async () => {
    const paymentUrl = "weixin://wxpay/bizpayurl/up?pr=NwY5Mz9&groupid=00";
    fetchMock.mockResolvedValue(signedWechat({ code_url: paymentUrl }));
    expect(await createScanPayment({ provider: "wechat", ...createInput() })).toEqual({ paymentUrl });
  });
  it.each([
    "weixin://wxpay/bizpayurl/up?groupid=00",
    "weixin://wxpay/bizpayurl/up/other?pr=abc",
    "weixin://user@wxpay/bizpayurl/up?pr=abc",
    "weixin://wxpay:1234/bizpayurl/up?pr=abc",
    "weixin://wxpay/bizpayurl/up?pr=abc#fragment",
    "weixin://foreign.example/bizpayurl/up?pr=abc"
  ])("rejects an invalid Native payment URL %s", async paymentUrl => {
    fetchMock.mockResolvedValue(signedWechat({ code_url: paymentUrl }));
    await expect(createScanPayment({ provider: "wechat", ...createInput() })).rejects.toThrow();
  });
  it("signs the request with merchant serial and verifies platform public key ID", async () => {
    fetchMock.mockResolvedValue(signedWechat({ code_url: "weixin://wxpay/bizpayurl?pr=test" }));
    expect(await createScanPayment({ provider: "wechat", ...createInput() })).toEqual({ paymentUrl: "weixin://wxpay/bizpayurl?pr=test" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.mch.weixin.qq.com/v3/pay/transactions/native");
    const headers = new Headers(init?.headers);
    const authorization = Object.fromEntries(Array.from(headers.get("authorization")!.matchAll(/(\w+)="([^"]+)"/g), match => [match[1], match[2]]));
    const canonical = `POST\n/v3/pay/transactions/native\n${authorization.timestamp}\n${authorization.nonce_str}\n${init?.body}\n`;
    expect(verify("RSA-SHA256", Buffer.from(canonical), merchant.publicKey, Buffer.from(authorization.signature, "base64"))).toBe(true);
    expect(authorization.serial_no).toBe(fixtureEnv.WECHAT_PAY_SERIAL_NO);
    expect(headers.get("Wechatpay-Serial")).toBe(publicKeyId);
    expect(JSON.parse(String(init?.body))).toMatchObject({ amount: { total: 30000, currency: "CNY" }, notify_url: "https://shaozhuangai.com/api/payments/wechat/notify" });
  });
  it("returns only signed successful order data", async () => {
    fetchMock.mockResolvedValue(signedWechat(wxTrade()));
    expect(await queryScanPayment("wechat", orderId)).toEqual({ provider: "wechat", orderId, receipt: "4200000123456789012345", amountCents: 30000 });
  });
  it("returns null for signed unpaid and nonexistent orders", async () => {
    fetchMock.mockResolvedValueOnce(signedWechat(wxTrade({ trade_state: "NOTPAY" }))).mockResolvedValueOnce(signedWechat({ code: "ORDER_NOT_EXIST" }, 404));
    expect(await queryScanPayment("wechat", orderId)).toBeNull();
    expect(await queryScanPayment("wechat", orderId)).toBeNull();
  });
  it("rejects unsigned errors, never treats an unverified 404 as nonexistent", async () => {
    fetchMock.mockResolvedValue(new Response('{"code":"ORDER_NOT_EXIST"}', { status: 404 }));
    await expect(queryScanPayment("wechat", orderId)).rejects.toMatchObject({ code: "PAYMENT_SIGNATURE_INVALID" });
  });
});

describe("WeChat signed encrypted notifications", () => {
  it("verifies and authenticates AES-GCM payment data", async () => {
    expect(await verifyScanNotification("wechat", wxNotify())).toEqual({ provider: "wechat", orderId, receipt: "4200000123456789012345", amountCents: 30000 });
  });
  it.each<Record<string, string>>([
    { "wechatpay-serial": "PUB_KEY_ID_999" },
    { "wechatpay-signature": "WECHATPAY/SIGNTEST/example" },
    { "wechatpay-timestamp": "1000000000" }
  ])("rejects mismatched key IDs, signature probes and old timestamps", async headers => {
    await expect(verifyScanNotification("wechat", wxNotify(wxTrade(), { headers }))).rejects.toMatchObject({ code: "PAYMENT_SIGNATURE_INVALID" });
  });
  it("rejects authenticated envelopes whose encrypted content has been corrupted", async () => {
    await expect(verifyScanNotification("wechat", wxNotify(wxTrade(), { badCipher: true }))).rejects.toMatchObject({ code: "PAYMENT_VERIFICATION_FAILED" });
  });
  it.each([{ mchid: "1900000002" }, { appid: "wx0000000000000000" }])("rejects another merchant or app", async override => {
    await expect(verifyScanNotification("wechat", wxNotify(wxTrade(override)))).rejects.toMatchObject({ code: "PAYMENT_MERCHANT_MISMATCH" });
  });
  it.each([{ amount: { total: 0, currency: "CNY" } }, { amount: { total: 1.2, currency: "CNY" } }, { amount: { total: 30000, currency: "USD" } }, { trade_type: "JSAPI" }])("rejects invalid money or the wrong payment product", async override => {
    await expect(verifyScanNotification("wechat", wxNotify(wxTrade(override)))).rejects.toThrow();
  });
  it("rejects oversized notification and provider bodies", async () => {
    const request = new Request("https://shaozhuangai.com/api/payments/alipay/notify", { method: "POST", body: "a".repeat(65537) });
    await expect(verifyScanNotification("alipay", request)).rejects.toMatchObject({ code: "PAYMENT_BODY_INVALID" });
    fetchMock.mockResolvedValue(new Response("x".repeat(65537)));
    await expect(queryScanPayment("alipay", orderId)).rejects.toMatchObject({ code: "PAYMENT_PROVIDER_REQUEST_FAILED" });
  });
  it("normalizes network failures without returning upstream text or credentials", async () => {
    fetchMock.mockRejectedValue(new Error("sensitive-provider-output"));
    await expect(queryScanPayment("alipay", orderId)).rejects.toMatchObject({ code: "PAYMENT_PROVIDER_REQUEST_FAILED", message: "支付信息校验失败，请稍后重试" });
  });
});
