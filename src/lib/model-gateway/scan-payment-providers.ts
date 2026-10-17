import "server-only";
import { createDecipheriv, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { GatewayPaymentError } from "@/lib/model-gateway/payment";

export type ScanProvider = "alipay" | "wechat";
/** Cryptographically verified provider result; callers must match their saved order and amount before crediting. */
export type VerifiedScanPayment = { provider: ScanProvider; orderId: string; receipt: string; amountCents: number };
type JsonObject = Record<string, unknown>;
type AlipayConfig = { appId: string; sellerId: string; privateKey: KeyObject; publicKey: KeyObject; notifyUrl: string; product: "precreate" | "page_pay" };
type WechatConfig = { appId: string; mchId: string; serial: string; publicKeyId: string; apiKey: Buffer; privateKey: KeyObject; publicKey: KeyObject; notifyUrl: string };
const BODY_LIMIT = 64 * 1024;
const HTTP_TIMEOUT = 8_000;
const ORDER_ID = /^[A-Za-z0-9_-]{6,32}$/;
const ALIPAY_GATEWAY = "https://openapi.alipay.com/gateway.do";

function fail(code = "PAYMENT_VERIFICATION_FAILED", status = 400): never {
  throw new GatewayPaymentError(code, code === "PAYMENT_PROVIDER_UNAVAILABLE" ? "此扫码支付方式暂未开通，请联系管理员" : "支付信息校验失败，请稍后重试", status);
}

function value(name: string): string {
  const result = process.env[name]?.trim();
  if (!result) fail("PAYMENT_PROVIDER_UNAVAILABLE", 503);
  return result;
}

function rsaKey(name: string, isPrivate: boolean): KeyObject {
  const pem = value(name).replace(/\\n/g, "\n");
  const key = isPrivate ? createPrivateKey(pem) : createPublicKey(pem);
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail("PAYMENT_PROVIDER_UNAVAILABLE", 503);
  return key;
}

function notifyUrl(provider: ScanProvider): string {
  const base = new URL(process.env.SCAN_PAYMENT_NOTIFY_BASE_URL?.trim() || "https://shaozhuangai.com");
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") fail("PAYMENT_PROVIDER_UNAVAILABLE", 503);
  return new URL(`/api/payments/${provider}/notify`, base).toString();
}

function alipayConfig(): AlipayConfig {
  try {
    const appId = value("ALIPAY_APP_ID");
    const sellerId = value("ALIPAY_SELLER_ID");
    const product = process.env.ALIPAY_PAYMENT_PRODUCT?.trim() || "precreate";
    if (!/^\d{16}$/.test(appId) || !/^2088\d{12}$/.test(sellerId) || !["precreate", "page_pay"].includes(product)) fail("PAYMENT_PROVIDER_UNAVAILABLE", 503);
    return { appId, sellerId, privateKey: rsaKey("ALIPAY_PRIVATE_KEY", true), publicKey: rsaKey("ALIPAY_PUBLIC_KEY", false), notifyUrl: notifyUrl("alipay"), product: product as AlipayConfig["product"] };
  } catch { return fail("PAYMENT_PROVIDER_UNAVAILABLE", 503); }
}

function wechatConfig(): WechatConfig {
  try {
    const appId = value("WECHAT_PAY_APP_ID");
    const mchId = value("WECHAT_PAY_MCH_ID");
    const serial = value("WECHAT_PAY_SERIAL_NO");
    const publicKeyId = value("WECHAT_PAY_PUBLIC_KEY_ID");
    const apiKey = Buffer.from(value("WECHAT_PAY_API_V3_KEY"), "utf8");
    if (!/^wx[A-Za-z0-9]{16}$/.test(appId) || !/^\d{6,32}$/.test(mchId) || !/^[0-9A-Fa-f]{16,64}$/.test(serial) || !/^PUB_KEY_ID_\d+$/.test(publicKeyId) || apiKey.length !== 32) fail("PAYMENT_PROVIDER_UNAVAILABLE", 503);
    return { appId, mchId, serial, publicKeyId, apiKey, privateKey: rsaKey("WECHAT_PAY_PRIVATE_KEY", true), publicKey: rsaKey("WECHAT_PAY_PUBLIC_KEY", false), notifyUrl: notifyUrl("wechat") };
  } catch { return fail("PAYMENT_PROVIDER_UNAVAILABLE", 503); }
}

/** Configuration readiness only; this does not assert merchant approval or a successful real payment. */
export function getScanProviderAvailability(): { provider: ScanProvider; available: boolean }[] {
  return (["alipay", "wechat"] as const).map(provider => {
    try {
      if (provider === "alipay") alipayConfig(); else wechatConfig();
      return { provider, available: true };
    }
    catch { return { provider, available: false }; }
  });
}

async function readBody(message: Request | Response): Promise<string> {
  const declaredSize = message.headers.get("content-length");
  if (declaredSize && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > BODY_LIMIT)) fail("PAYMENT_BODY_INVALID");
  if (!message.body) return "";
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(new GatewayPaymentError("PAYMENT_BODY_TIMEOUT", "支付信息读取超时，请稍后重试", 408));
    }, 4_000);
  });
  try {
    while (true) {
      const { done, value: chunk } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += chunk.byteLength;
      if (size > BODY_LIMIT) { await reader.cancel(); fail("PAYMENT_BODY_INVALID"); }
      chunks.push(chunk);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

function object(data: unknown): JsonObject {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail();
  return data as JsonObject;
}

function parseObject(text: string): JsonObject {
  try { return object(JSON.parse(text)); } catch { return fail(); }
}

function signatureValid(text: string, signature: unknown, key: KeyObject): boolean {
  if (typeof signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  try { return verify("RSA-SHA256", Buffer.from(text, "utf8"), key, Buffer.from(signature, "base64")); }
  catch { return false; }
}

// Keep each top-level JSON value byte-for-byte: Alipay signs the original response fragment,
// including its whitespace and escapes. Reject duplicate root keys rather than parsing a different value.
function rawObjectFields(text: string): Map<string, string> {
  const result = new Map<string, string>();
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(text[cursor] || "!") && cursor < text.length) cursor++; };
  const stringEnd = (start: number) => {
    for (let at = start + 1; at < text.length; at++) {
      if (text[at] === "\\") { at++; continue; }
      if (text[at] === '"') return at + 1;
    }
    return fail();
  };
  whitespace();
  if (text[cursor++] !== "{") fail();
  whitespace();
  while (text[cursor] !== "}") {
    if (text[cursor] !== '"') fail();
    const keyEnd = stringEnd(cursor);
    const key = JSON.parse(text.slice(cursor, keyEnd)) as string;
    if (result.has(key)) fail();
    cursor = keyEnd;
    whitespace();
    if (text[cursor++] !== ":") fail();
    whitespace();
    const start = cursor;
    let depth = 0;
    for (; cursor < text.length; cursor++) {
      const character = text[cursor];
      if (character === '"') { cursor = stringEnd(cursor) - 1; continue; }
      if (character === "{" || character === "[") depth++;
      else if (character === "}" || character === "]") {
        if (depth === 0) break;
        depth--;
      } else if (character === "," && depth === 0) break;
    }
    const raw = text.slice(start, cursor).trimEnd();
    JSON.parse(raw);
    result.set(key, raw);
    whitespace();
    if (text[cursor] === "}") break;
    if (text[cursor++] !== ",") fail();
    whitespace();
    if (text[cursor] === "}") fail();
  }
  if (text[cursor++] !== "}") fail();
  whitespace();
  if (cursor !== text.length) fail();
  return result;
}

function alipayCanonical(parameters: Record<string, string>, notification = false): string {
  return Object.keys(parameters).filter(key => key !== "sign" && (!notification || key !== "sign_type") && parameters[key] !== "").sort().map(key => `${key}=${parameters[key]}`).join("&");
}

function beijingTime(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}

function alipayParameters(config: AlipayConfig, method: string, business: JsonObject): Record<string, string> {
  return {
    app_id: config.appId, method, format: "JSON", charset: "utf-8", sign_type: "RSA2", version: "1.0",
    timestamp: beijingTime(new Date()), biz_content: JSON.stringify(business),
    ...(method !== "alipay.trade.query" ? { notify_url: config.notifyUrl } : {})
  };
}

function signAlipayParameters(config: AlipayConfig, parameters: Record<string, string>): Record<string, string> {
  return { ...parameters, sign: sign("RSA-SHA256", Buffer.from(alipayCanonical(parameters)), config.privateKey).toString("base64") };
}

function alipayPageUrl(config: AlipayConfig, parameters: Record<string, string>): string {
  return `${ALIPAY_GATEWAY}?${new URLSearchParams(signAlipayParameters(config, parameters)).toString()}`;
}

/** Only expose our own signed page-pay URL for the exact saved order. A gateway URL alone is not trusted. */
export function getAlipayPageCheckout(input: { paymentUrl: string; orderId: string; amountCents: number; expiresAt: Date }): { cashierUrl: string; fallbackCashierUrl: string } | null {
  try {
    if (input.paymentUrl.length > 8192) return null;
    const url = new URL(input.paymentUrl);
    if (url.origin !== "https://openapi.alipay.com" || url.pathname !== "/gateway.do" || url.username || url.password || url.hash) return null;
    const parameters: Record<string, string> = Object.create(null);
    for (const [key, val] of url.searchParams) {
      if (Object.hasOwn(parameters, key)) return null;
      parameters[key] = val;
    }
    const expectedKeys = ["app_id", "method", "format", "charset", "sign_type", "version", "timestamp", "biz_content", "notify_url", "sign"];
    if (Object.keys(parameters).length !== expectedKeys.length || expectedKeys.some(key => !parameters[key])) return null;
    const config = alipayConfig();
    if (parameters.app_id !== config.appId || parameters.method !== "alipay.trade.page.pay" || parameters.format !== "JSON" ||
        parameters.charset !== "utf-8" || parameters.sign_type !== "RSA2" || parameters.version !== "1.0" ||
        parameters.notify_url !== config.notifyUrl || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(parameters.timestamp) ||
        !signatureValid(alipayCanonical(parameters), parameters.sign, createPublicKey(config.privateKey))) return null;
    const business = parseObject(parameters.biz_content);
    const businessKeys = ["out_trade_no", "total_amount", "subject", "time_expire", "product_code", "qr_pay_mode", "qrcode_width"];
    if (rawObjectFields(parameters.biz_content).size !== businessKeys.length || businessKeys.some(key => !Object.hasOwn(business, key)) ||
        business.out_trade_no !== input.orderId || business.total_amount !== (input.amountCents / 100).toFixed(2) ||
        business.time_expire !== beijingTime(input.expiresAt) || business.product_code !== "FAST_INSTANT_TRADE_PAY" ||
        business.qr_pay_mode !== "4" || business.qrcode_width !== 220 || typeof business.subject !== "string" ||
        !business.subject.trim() || business.subject.length > 127) return null;
    // Keep the original timestamp stable during polling; changing mode invalidates the old
    // signature, so the full-page fallback must be independently signed on the server.
    const fallbackBusiness: JsonObject = { ...business, qr_pay_mode: "2" };
    delete fallbackBusiness.qrcode_width;
    return { cashierUrl: input.paymentUrl, fallbackCashierUrl: alipayPageUrl(config, { ...parameters, biz_content: JSON.stringify(fallbackBusiness) }) };
  } catch { return null; }
}

async function providerRequest(url: string, init: RequestInit): Promise<{ response: Response; text: string }> {
  try {
    const response = await fetch(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(HTTP_TIMEOUT) });
    return { response, text: await readBody(response) };
  } catch { return fail("PAYMENT_PROVIDER_REQUEST_FAILED", 502); }
}

async function alipayRequest(config: AlipayConfig, method: "alipay.trade.precreate" | "alipay.trade.query", business: JsonObject): Promise<JsonObject> {
  const parameters = signAlipayParameters(config, alipayParameters(config, method, business));
  const { response, text } = await providerRequest(ALIPAY_GATEWAY, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", accept: "application/json" }, body: new URLSearchParams(parameters).toString() });
  const fields = rawObjectFields(text);
  const raw = fields.get(`${method.replaceAll(".", "_")}_response`) ?? fields.get("error_response");
  const signature = fields.get("sign");
  if (!raw || !signature || !signatureValid(raw, JSON.parse(signature), config.publicKey)) fail("PAYMENT_SIGNATURE_INVALID", 502);
  if (!response.ok) fail("PAYMENT_PROVIDER_REQUEST_FAILED", 502);
  return parseObject(raw);
}

function verifyWechatEnvelope(config: WechatConfig, headers: Headers, text: string): void {
  const timestamp = headers.get("wechatpay-timestamp") || "";
  const nonce = headers.get("wechatpay-nonce") || "";
  if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !nonce || nonce.length > 256 || headers.get("wechatpay-serial") !== config.publicKeyId || !signatureValid(`${timestamp}\n${nonce}\n${text}\n`, headers.get("wechatpay-signature"), config.publicKey)) fail("PAYMENT_SIGNATURE_INVALID");
}

async function wechatRequest(config: WechatConfig, method: "GET" | "POST", path: string, body?: JsonObject): Promise<JsonObject> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const payload = body ? JSON.stringify(body) : "";
  const signature = sign("RSA-SHA256", Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${payload}\n`), config.privateKey).toString("base64");
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.serial}",signature="${signature}"`;
  const { response, text } = await providerRequest(`https://api.mch.weixin.qq.com${path}`, { method, headers: { authorization, "content-type": "application/json", accept: "application/json", "Wechatpay-Serial": config.publicKeyId }, ...(body ? { body: payload } : {}) });
  verifyWechatEnvelope(config, response.headers, text);
  const result = parseObject(text);
  if (!response.ok && !(response.status === 404 && result.code === "ORDER_NOT_EXIST")) fail("PAYMENT_PROVIDER_REQUEST_FAILED", 502);
  return result;
}

function cents(amount: unknown): number {
  if (typeof amount === "number" && Number.isFinite(amount)) amount = String(amount);
  if (typeof amount !== "string" || !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(amount)) fail("PAYMENT_AMOUNT_INVALID");
  const [whole, fraction = ""] = amount.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result <= 0) fail("PAYMENT_AMOUNT_INVALID");
  return result;
}

function verified(provider: ScanProvider, orderId: unknown, receipt: unknown, amountCents: unknown): VerifiedScanPayment {
  if (typeof orderId !== "string" || !ORDER_ID.test(orderId) || typeof receipt !== "string" || !/^[A-Za-z0-9_-]{6,64}$/.test(receipt) || typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents <= 0) fail();
  return { provider, orderId, receipt, amountCents };
}

function alipayPayment(data: JsonObject, config: AlipayConfig, isNotification: boolean): VerifiedScanPayment | null {
  if (isNotification && (data.app_id !== config.appId || data.seller_id !== config.sellerId)) fail("PAYMENT_MERCHANT_MISMATCH");
  // Query responses need not contain seller/app IDs. The signed request is scoped to our own
  // app (no third-party app_auth_token); an explicitly returned identity must still match.
  if ((data.app_id !== undefined && data.app_id !== config.appId) || (data.seller_id !== undefined && data.seller_id !== config.sellerId) || (data.seller_user_id !== undefined && data.seller_user_id !== config.sellerId)) fail("PAYMENT_MERCHANT_MISMATCH");
  // Domestic 当面付 defines total_amount in RMB yuan. Do not accept a foreign currency
  // if a provider response explicitly carries one (e.g. an unintended overseas product).
  if ([data.currency, data.trans_currency, data.settle_currency].some(currency => currency !== undefined && currency !== "CNY")) fail("PAYMENT_CURRENCY_INVALID");
  if (!["TRADE_SUCCESS", "TRADE_FINISHED"].includes(String(data.trade_status))) return null;
  return verified("alipay", data.out_trade_no, data.trade_no, cents(data.total_amount));
}

function wechatPayment(data: JsonObject, config: WechatConfig): VerifiedScanPayment | null {
  if (data.appid !== config.appId || data.mchid !== config.mchId) fail("PAYMENT_MERCHANT_MISMATCH");
  if (data.trade_state !== "SUCCESS") return null;
  const amount = object(data.amount);
  if (data.trade_type !== "NATIVE" || amount.currency !== "CNY") fail();
  return verified("wechat", data.out_trade_no, data.transaction_id, amount.total);
}

export async function createScanPayment(input: { provider: ScanProvider; orderId: string; description: string; amountCents: number; expiresAt: Date }): Promise<{ paymentUrl: string }> {
  if (!ORDER_ID.test(input.orderId) || !Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > 100_000_000 || typeof input.description !== "string" || !input.description.trim() || input.description.length > 127 || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() - Date.now() < 60_000 || input.expiresAt.getTime() - Date.now() > 7 * 86400_000) fail("PAYMENT_ORDER_INVALID");
  if (input.provider === "alipay") {
    const config = alipayConfig();
    const expiresAtBeijing = beijingTime(input.expiresAt);
    if (config.product === "page_pay") {
      // page.pay is a browser request, not a JSON API or a QR payload. No precreate call
      // is made; an upstream transaction may not exist until this signed URL is opened.
      return { paymentUrl: alipayPageUrl(config, alipayParameters(config, "alipay.trade.page.pay", {
        out_trade_no: input.orderId, total_amount: (input.amountCents / 100).toFixed(2), subject: input.description,
        time_expire: expiresAtBeijing, product_code: "FAST_INSTANT_TRADE_PAY", qr_pay_mode: "4", qrcode_width: 220
      })) };
    }
    const data = await alipayRequest(config, "alipay.trade.precreate", { out_trade_no: input.orderId, seller_id: config.sellerId, total_amount: (input.amountCents / 100).toFixed(2), subject: input.description, time_expire: expiresAtBeijing });
    if (data.code !== "10000") fail("PAYMENT_PROVIDER_REQUEST_FAILED", 502);
    if (data.out_trade_no !== input.orderId || typeof data.qr_code !== "string") fail();
    let url: URL;
    try { url = new URL(data.qr_code); } catch { return fail(); }
    if (url.protocol !== "https:" || url.hostname !== "qr.alipay.com" || url.username || url.password || url.port) fail();
    return { paymentUrl: url.toString() };
  }
  if (input.provider !== "wechat") fail("PAYMENT_PROVIDER_UNAVAILABLE", 503);
  const config = wechatConfig();
  const data = await wechatRequest(config, "POST", "/v3/pay/transactions/native", { appid: config.appId, mchid: config.mchId, description: input.description, out_trade_no: input.orderId, time_expire: input.expiresAt.toISOString(), notify_url: config.notifyUrl, amount: { total: input.amountCents, currency: "CNY" } });
  if (typeof data.code_url !== "string") fail();
  let url: URL;
  try { url = new URL(data.code_url); } catch { return fail(); }
  if (url.protocol !== "weixin:" || url.hostname !== "wxpay" || !["/bizpayurl", "/bizpayurl/up"].includes(url.pathname) || !url.searchParams.get("pr") || url.username || url.password || url.port || url.hash) fail();
  return { paymentUrl: data.code_url };
}

export async function queryScanPayment(provider: ScanProvider, orderId: string): Promise<VerifiedScanPayment | null> {
  if (!ORDER_ID.test(orderId)) fail("PAYMENT_ORDER_INVALID");
  let payment: VerifiedScanPayment | null;
  if (provider === "alipay") {
    const config = alipayConfig();
    const data = await alipayRequest(config, "alipay.trade.query", { out_trade_no: orderId });
    if (data.code === "40004" && data.sub_code === "ACQ.TRADE_NOT_EXIST") return null;
    if (data.code !== "10000") fail("PAYMENT_PROVIDER_REQUEST_FAILED", 502);
    if (data.out_trade_no !== orderId) fail("PAYMENT_ORDER_MISMATCH");
    payment = alipayPayment(data, config, false);
  } else if (provider === "wechat") {
    const config = wechatConfig();
    const data = await wechatRequest(config, "GET", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}?mchid=${encodeURIComponent(config.mchId)}`);
    if (data.code === "ORDER_NOT_EXIST") return null;
    if (data.out_trade_no !== orderId) fail("PAYMENT_ORDER_MISMATCH");
    payment = wechatPayment(data, config);
  } else { return fail("PAYMENT_PROVIDER_UNAVAILABLE", 503); }
  return payment;
}

export async function verifyScanNotification(provider: ScanProvider, request: Request): Promise<VerifiedScanPayment | null> {
  try {
    if (request.method !== "POST") fail();
    const text = await readBody(request);
    if (provider === "alipay") {
      const config = alipayConfig();
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) fail();
      const data: Record<string, string> = Object.create(null);
      for (const [key, val] of new URLSearchParams(text)) {
        if (Object.hasOwn(data, key)) fail();
        data[key] = val;
      }
      if (data.sign_type !== "RSA2" || !signatureValid(alipayCanonical(data, true), data.sign, config.publicKey)) fail("PAYMENT_SIGNATURE_INVALID");
      return alipayPayment(data, config, true);
    }
    if (provider !== "wechat") fail();
    const config = wechatConfig();
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) fail();
    verifyWechatEnvelope(config, request.headers, text);
    const envelope = parseObject(text);
    if (envelope.event_type !== "TRANSACTION.SUCCESS") return null;
    const resource = object(envelope.resource);
    if (envelope.resource_type !== "encrypt-resource" || resource.algorithm !== "AEAD_AES_256_GCM" || typeof resource.nonce !== "string" || typeof resource.ciphertext !== "string" || (resource.associated_data !== undefined && typeof resource.associated_data !== "string")) fail();
    const encrypted = Buffer.from(resource.ciphertext, "base64");
    if (encrypted.length <= 16) fail();
    const decipher = createDecipheriv("aes-256-gcm", config.apiKey, Buffer.from(resource.nonce));
    decipher.setAuthTag(encrypted.subarray(-16));
    decipher.setAAD(Buffer.from((resource.associated_data as string | undefined) ?? ""));
    const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8");
    return wechatPayment(parseObject(plain), config);
  } catch (error) {
    if (error instanceof GatewayPaymentError) throw error;
    return fail();
  }
}
