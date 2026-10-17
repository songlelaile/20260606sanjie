import "server-only";
import { createHash } from "node:crypto";
import type { GatewayModel } from "./catalog";
import { GatewayBillingError } from "./billing-contract";

type Endpoint = GatewayModel["endpoint"] | "images.edits";
type Body = Record<string, unknown>;

/** Freeze the same output budget that is actually sent to the supplier. */
export function prepareGatewayBillingQuote(model: GatewayModel, endpoint: Endpoint, body: Body): number {
  if (endpoint === "chat.completions") {
    if (body.n !== undefined && body.n !== 1) throw new GatewayBillingError("INVALID_CHOICE_COUNT", "文本请求目前仅支持单个结果（n=1）", 400);
    if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) {
      throw new GatewayBillingError("INVALID_TOKEN_BUDGET", "请只设置一种输出 token 上限");
    }
    if (body.max_tokens === undefined && body.max_completion_tokens === undefined) body.max_completion_tokens = 1024;
    const limit = body.max_completion_tokens ?? body.max_tokens;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000_000) {
      throw new GatewayBillingError("INVALID_TOKEN_BUDGET", "输出 token 上限必须是 1 到 1000000 的整数");
    }
    // A conservative byte budget avoids under-reserving Chinese/tool context.
    // This is still a catalog quote; settlement uses the supplier's actual usage/cost.
    const input = Math.max(1, Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools,
      functions: body.functions, response_format: body.response_format }), "utf8"));
    return Math.max(1, Math.ceil(input / 1000 * (model.promptCentsPer1K ?? 1)) + Math.ceil(limit / 1000 * (model.completionCentsPer1K ?? 2)));
  }
  if (endpoint === "videos") {
    if (!Number.isSafeInteger(model.videoCents) || Number(model.videoCents) <= 0) throw new GatewayBillingError("VIDEO_PRICE_MISSING", "视频模型尚未配置任务计价", 503);
    return Number(model.videoCents);
  }
  const n = body.n ?? 1;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > 10) throw new GatewayBillingError("INVALID_IMAGE_COUNT", "n 必须是 1 到 10 的整数");
  return Math.max(1, Math.ceil(n * (model.imageCents ?? 50)));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Hash, never persist, prompts or uploaded bytes. Order of multipart entries matters. */
export async function gatewayRequestFingerprint(input: { endpoint: string; model: string; body: Body; form?: FormData }): Promise<string> {
  const entries = input.form ? await Promise.all([...input.form.entries()].map(async ([name, value]) => [name, typeof value === "string" ? value : {
    bytes: value.size, type: value.type, hash: createHash("sha256").update(new Uint8Array(await value.arrayBuffer())).digest("hex")
  }])) : undefined;
  return createHash("sha256").update(JSON.stringify(canonical({ endpoint: input.endpoint, model: input.model, body: input.body, entries }))).digest("hex");
}

export function gatewayOutcomeFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
