import "server-only";
import { NextResponse } from "next/server";
import { findGatewayModel, type GatewayModel } from "@/lib/model-gateway/catalog";
import {
  assertGatewayBalance,
  authenticateGatewayKey,
  recordGatewayUsage,
  type GatewayAuth
} from "@/lib/model-gateway/store";

type JsonObject = Record<string, unknown>;

function upstreamUrl(model: GatewayModel) {
  const base = (process.env[model.baseUrlEnv] || model.defaultBaseUrl).replace(/\/+$/, "");
  if (model.endpoint === "images.generations") {
    return `${base}/images/generations`;
  }
  return `${base}/chat/completions`;
}

function upstreamApiKey(model: GatewayModel) {
  return process.env[model.apiKeyEnv] || "";
}

function textSizeTokens(body: JsonObject) {
  const raw = JSON.stringify(body.messages || body.input || body.prompt || "");
  return Math.max(1, Math.ceil(raw.length / 4));
}

function tokenCostCents(model: GatewayModel, promptTokens: number, completionTokens: number) {
  const inputCost = Math.ceil((promptTokens / 1000) * (model.promptCentsPer1K || 1));
  const outputCost = Math.ceil((completionTokens / 1000) * (model.completionCentsPer1K || 2));
  return Math.max(1, inputCost + outputCost);
}

function imageCostCents(model: GatewayModel, count: number) {
  return Math.max(1, count * (model.imageCents || 50));
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: { message, type: "model_gateway_error" } }, { status });
}

async function parseGatewayRequest(request: Request, endpoint: GatewayModel["endpoint"]) {
  const auth = await authenticateGatewayKey(request.headers.get("authorization"));
  if (!auth) {
    return { error: jsonError("API Key 无效或已停用", 401) };
  }
  const hasBalance = await assertGatewayBalance(auth.userId);
  if (!hasBalance) {
    return { error: jsonError("余额不足，请先购买模型额度", 402) };
  }
  const body = (await request.json().catch(() => null)) as JsonObject | null;
  if (!body || typeof body !== "object") {
    return { error: jsonError("请求体必须是 JSON", 400) };
  }
  if (body.stream === true) {
    return { error: jsonError("MVP 暂不支持 stream=true，请使用非流式请求", 400) };
  }
  const modelName = String(body.model || "");
  const model = findGatewayModel(modelName, endpoint);
  if (!model) {
    return { error: jsonError(`模型未开通或端点不匹配：${modelName}`, 404) };
  }
  const apiKey = upstreamApiKey(model);
  if (!apiKey) {
    return { error: jsonError(`上游 ${model.provider} 还没有配置 API Key`, 503) };
  }
  return { auth, body, model };
}

async function forwardJson(model: GatewayModel, body: JsonObject) {
  const upstreamBody = { ...body, model: model.upstreamModel };
  const resp = await fetch(upstreamUrl(model), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${upstreamApiKey(model)}`
    },
    body: JSON.stringify(upstreamBody),
    cache: "no-store"
  });
  const text = await resp.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // leave text response as-is
  }
  return { status: resp.status, data, text };
}

async function recordChatUsage(auth: GatewayAuth, model: GatewayModel, response: { status: number; data: unknown }, body: JsonObject) {
  const ok = response.status >= 200 && response.status < 300;
  const data = response.data as { id?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; error?: { message?: string } };
  const promptTokens = data?.usage?.prompt_tokens ?? textSizeTokens(body);
  const completionTokens = data?.usage?.completion_tokens ?? 0;
  const totalTokens = data?.usage?.total_tokens ?? promptTokens + completionTokens;
  await recordGatewayUsage({
    auth,
    endpoint: "chat.completions",
    provider: model.provider,
    model: model.id,
    requestId: data?.id || "",
    promptTokens,
    completionTokens,
    totalTokens,
    costCents: ok ? tokenCostCents(model, promptTokens, completionTokens) : 0,
    status: ok ? "ok" : "error",
    error: ok ? "" : data?.error?.message || "upstream_error",
    metadata: { upstreamModel: model.upstreamModel }
  });
}

async function recordImageUsage(auth: GatewayAuth, model: GatewayModel, response: { status: number; data: unknown }, body: JsonObject) {
  const ok = response.status >= 200 && response.status < 300;
  const data = response.data as { id?: string; data?: unknown[]; error?: { message?: string } };
  const count = Math.max(1, Number(body.n || (Array.isArray(data?.data) ? data.data.length : 1)) || 1);
  await recordGatewayUsage({
    auth,
    endpoint: "images.generations",
    provider: model.provider,
    model: model.id,
    requestId: data?.id || "",
    imageCount: count,
    costCents: ok ? imageCostCents(model, count) : 0,
    status: ok ? "ok" : "error",
    error: ok ? "" : data?.error?.message || "upstream_error",
    metadata: { upstreamModel: model.upstreamModel, size: body.size || "" }
  });
}

export async function handleGatewayChatCompletions(request: Request) {
  const parsed = await parseGatewayRequest(request, "chat.completions");
  if ("error" in parsed) return parsed.error;
  const { auth, body, model } = parsed;
  const response = await forwardJson(model, body);
  await recordChatUsage(auth, model, response, body);
  return NextResponse.json(response.data, { status: response.status });
}

export async function handleGatewayImageGenerations(request: Request) {
  const parsed = await parseGatewayRequest(request, "images.generations");
  if ("error" in parsed) return parsed.error;
  const { auth, body, model } = parsed;
  const response = await forwardJson(model, body);
  await recordImageUsage(auth, model, response, body);
  return NextResponse.json(response.data, { status: response.status });
}
