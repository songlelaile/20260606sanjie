export class GatewayPaymentError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "GatewayPaymentError";
  }
}

export type ManualPaymentConfirmation = {
  receipt: string;
  receivedAmountCents: number;
  note: string;
  confirmedBy: string;
};

export function parseManualPaymentConfirmation(body: unknown, confirmedBy: string): ManualPaymentConfirmation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GatewayPaymentError("INVALID_CONFIRMATION", "请提交付款凭证和实收金额", 400);
  }
  const value = body as Record<string, unknown>;
  const receipt = typeof value.receipt === "string" ? value.receipt.trim() : "";
  const note = typeof value.note === "string" ? value.note.trim() : "";
  if (receipt.length < 4 || receipt.length > 160 || /[\u0000-\u001f\u007f]/u.test(receipt)) {
    throw new GatewayPaymentError("INVALID_RECEIPT", "付款凭证需为 4 至 160 字符的真实收款流水号", 400);
  }
  if (!Number.isSafeInteger(value.receivedAmountCents) || Number(value.receivedAmountCents) <= 0) {
    throw new GatewayPaymentError("INVALID_RECEIVED_AMOUNT", "实收金额必须是正整数人民币分", 400);
  }
  if ((value.note !== undefined && typeof value.note !== "string") || note.length > 500) {
    throw new GatewayPaymentError("INVALID_NOTE", "确认备注不能超过 500 字符", 400);
  }
  if (typeof confirmedBy !== "string" || !confirmedBy.trim()) {
    throw new GatewayPaymentError("INVALID_CONFIRMING_ADMIN", "缺少确认管理员", 403);
  }
  return { receipt, note, receivedAmountCents: Number(value.receivedAmountCents), confirmedBy };
}

/** Only manual confirmation is implemented. Unknown providers must never create a fake checkout. */
export function getGatewayManualPaymentConfig(env: Record<string, string | undefined> = process.env) {
  const provider = env.MODEL_GATEWAY_PAYMENT_PROVIDER?.trim() || "manual";
  if (provider !== "manual") {
    throw new GatewayPaymentError("PAYMENT_PROVIDER_UNAVAILABLE", "此支付供应商尚未接通，请联系管理员使用人工收款确认", 503);
  }
  const paymentUrl = env.MODEL_GATEWAY_MANUAL_PAY_URL?.trim() || "";
  if (paymentUrl) {
    let parsed: URL;
    try {
      parsed = new URL(paymentUrl);
    } catch {
      throw new GatewayPaymentError("PAYMENT_CONFIGURATION_INVALID", "收款地址配置无效，请联系管理员", 503);
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new GatewayPaymentError("PAYMENT_CONFIGURATION_INVALID", "收款地址配置无效，请联系管理员", 503);
    }
  }
  return { paymentProvider: "manual", paymentUrl };
}

export function gatewayPaymentErrorResponse(error: unknown, fallback: string) {
  if (error instanceof GatewayPaymentError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  return { status: 503, body: { error: fallback, code: "PAYMENT_SERVICE_UNAVAILABLE" } };
}
