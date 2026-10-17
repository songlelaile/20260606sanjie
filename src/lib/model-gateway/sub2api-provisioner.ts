import "server-only";
import { createHash } from "node:crypto";
import { readSub2ApiProvisionConfig, Sub2ApiProvisionError, getSub2ApiProvisioningView } from "@/lib/model-gateway/sub2api-provision-config";
export { Sub2ApiProvisionError, getSub2ApiProvisioningView, saveSub2ApiProvisionConfig } from "@/lib/model-gateway/sub2api-provision-config";

const RESPONSE_LIMIT = 1_048_576;
const REQUEST_TIMEOUT_MS = 15_000;

type Configuration = { root: string; email: string; password: string; groupId: string; quota: number; identity: string };
type Session = { accessToken: string; refreshToken: string; ownerId: string; expiresAt: number };
type SessionState = { session?: Session; pending?: Promise<Session> };
type ProvisionInput = { name: string; customKey: string; idempotencyKey: string };
export type ProvisionedSub2ApiKey = { id: string; key: string; groupId: string; ownerId: string };
const sessions = new Map<string, SessionState>();

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function fail(message: string, code: string, status = 503): never {
  throw new Sub2ApiProvisionError(message, status, code);
}

function positiveId(value: unknown): string | null {
  const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? String(Number(text)) : null;
}

async function configuration(): Promise<Configuration> {
  const stored = await readSub2ApiProvisionConfig();
  if (!stored.email || !stored.password.trim() || !stored.groupId || stored.quotaUsd === null) {
    fail("上游密钥自动签发尚未配置", "supply_provisioning_unconfigured");
  }
  // Zero is an explicit unlimited *key* ceiling. It does not grant money or a
  // subscription and does not replace the upstream wallet or local balance gate.
  const identity = createHash("sha256").update(JSON.stringify([stored.baseUrl, stored.email, stored.password])).digest("hex");
  return { root: stored.baseUrl, email: stored.email, password: stored.password, groupId: stored.groupId, quota: stored.quotaUsd, identity };
}

export async function provisioningConfigured(): Promise<boolean> {
  return (await getSub2ApiProvisioningView()).configured;
}

function validateInput(input: ProvisionInput) {
  if (typeof input?.name !== "string" || !input.name.trim() || input.name !== input.name.trim() || input.name.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(input.name) || typeof input.customKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(input.customKey) ||
      typeof input.idempotencyKey !== "string" || !/^[\x21-\x7e]{1,128}$/.test(input.idempotencyKey)) {
    fail("上游密钥签发参数无效", "supply_provisioning_invalid_input", 400);
  }
}

async function requestJson(config: Configuration, path: string, init: RequestInit = {}): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(config.root + path, { ...init, signal: abort.signal, redirect: "error", cache: "no-store" });
    if (response.status === 401) fail("上游签发身份认证失败", "supply_provisioning_auth_rejected");
    if (response.status === 429) fail("上游签发已达创建频率限制，请等待额度窗口恢复", "supply_provisioning_rate_limited", 429);
    if (!response.ok && response.status !== 403) fail("上游密钥签发接口暂不可用", "supply_provisioning_upstream_failed");
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > RESPONSE_LIMIT) {
      await response.body?.cancel().catch(() => undefined);
      fail("上游签发响应超出大小限制", "supply_provisioning_response_too_large", 502);
    }
    if (!response.body) fail("上游签发响应为空", "supply_provisioning_invalid_response", 502);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > RESPONSE_LIMIT) {
          await reader.cancel().catch(() => undefined);
          fail("上游签发响应超出大小限制", "supply_provisioning_response_too_large", 502);
        }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let envelope: Record<string, unknown> | null;
    try { envelope = record(JSON.parse(new TextDecoder().decode(bytes))); }
    catch {
      if (!response.ok) fail("上游密钥签发接口暂不可用", "supply_provisioning_upstream_failed");
      fail("上游签发响应格式无效", "supply_provisioning_invalid_response", 502);
    }
    if (!response.ok) {
      const reason = typeof envelope?.reason === "string" ? envelope.reason : envelope?.code;
      if (reason === "API_KEY_COUNT_EXCEEDED") fail("上游服务账号密钥数量已达上限，请管理员调整签发账号", "supply_provisioning_key_count_exceeded");
      if (reason === "GROUP_NOT_ALLOWED") fail("上游服务账号未获授权访问指定分组", "supply_provisioning_group_forbidden");
      fail("上游密钥签发接口暂不可用", "supply_provisioning_upstream_failed");
    }
    if (!envelope || (envelope.code !== 0 && envelope.code !== "0") || !("data" in envelope)) {
      fail("上游签发响应未确认成功", "supply_provisioning_invalid_response", 502);
    }
    return envelope.data;
  } catch (error) {
    if (error instanceof Sub2ApiProvisionError) throw error;
    if (abort.signal.aborted) fail("上游密钥签发请求超时，请使用原任务重试", "supply_provisioning_timeout", 504);
    fail("无法连接上游密钥签发服务", "supply_provisioning_network_failed", 502);
  } finally { clearTimeout(timer); }
}

function sessionFromResponse(data: unknown, expectedOwner?: string): Session {
  const row = record(data);
  if (row?.requires_2fa === true) fail("上游签发账号要求二次认证，请先完成服务账号配置", "supply_provisioning_2fa_required");
  const ownerId = positiveId(record(row?.user)?.id) || expectedOwner;
  if (row && record(row.user)?.status && record(row.user)?.status !== "active") {
    fail("上游签发账号未启用", "supply_provisioning_inactive_owner");
  }
  const accessToken = row?.access_token;
  const refreshToken = row?.refresh_token;
  if (!ownerId || (expectedOwner && ownerId !== expectedOwner) || typeof accessToken !== "string" || !accessToken || accessToken.length > 16_384 ||
      /[\u0000-\u0020\u007f]/.test(accessToken) || typeof refreshToken !== "string" || !refreshToken || refreshToken.length > 16_384) {
    fail("上游签发身份响应无效", "supply_provisioning_invalid_session", 502);
  }
  const expiresIn = typeof row?.expires_in === "number" && Number.isFinite(row.expires_in) && row.expires_in > 0
    ? Math.min(row.expires_in, 168 * 3600) : 300;
  return { ownerId, accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
}

function sessionState(config: Configuration): SessionState {
  let state = sessions.get(config.identity);
  if (!state) {
    if (sessions.size >= 8) sessions.delete(sessions.keys().next().value!);
    state = {};
    sessions.set(config.identity, state);
  }
  return state;
}

async function getSession(config: Configuration, rejected?: Session): Promise<Session> {
  const state = sessionState(config);
  if (state.session && state.session.expiresAt > Date.now() + 5000 && (!rejected || state.session.accessToken !== rejected.accessToken)) return state.session;
  if (state.pending) return state.pending;
  const previous = state.session;
  const pending = (async () => {
    const data = previous
      ? await requestJson(config, "/api/v1/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: previous.refreshToken }) })
      : await requestJson(config, "/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: config.email, password: config.password }) });
    const session = sessionFromResponse(data, previous?.ownerId);
    state.session = session;
    return session;
  })();
  state.pending = pending;
  try { return await pending; }
  catch (error) { state.session = undefined; throw error; }
  finally { if (state.pending === pending) state.pending = undefined; }
}

async function authenticatedRequest(config: Configuration, session: Session, path: string, init: RequestInit = {}): Promise<{ data: unknown; session: Session }> {
  const perform = (current: Session) => requestJson(config, path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${current.accessToken}` } });
  try { return { data: await perform(session), session }; }
  catch (error) {
    if (!(error instanceof Sub2ApiProvisionError) || error.code !== "supply_provisioning_auth_rejected") throw error;
    const refreshed = await getSession(config, session);
    return { data: await perform(refreshed), session: refreshed };
  }
}

function confirmKey(raw: unknown, input: ProvisionInput, config: Configuration, ownerId: string): ProvisionedSub2ApiKey {
  const row = record(raw);
  const id = positiveId(row?.id);
  if (!id || row?.name !== input.name || row.key !== input.customKey || positiveId(row.group_id) !== config.groupId ||
      positiveId(row.user_id) !== ownerId || row.status !== "active") {
    fail("上游密钥身份、归属或启用状态未通过确认", "supply_provisioning_key_mismatch", 502);
  }
  return { id, key: input.customKey, groupId: config.groupId, ownerId };
}

async function findExisting(config: Configuration, session: Session, input: ProvisionInput): Promise<{ key: ProvisionedSub2ApiKey | null; session: Session }> {
  let current = session;
  let found: ProvisionedSub2ApiKey | null = null;
  for (let page = 1; page <= 20; page++) {
    const query = new URLSearchParams({ search: input.name, page: String(page), page_size: "100" });
    const result = await authenticatedRequest(config, current, `/api/v1/keys?${query}`);
    current = result.session;
    const data = record(result.data);
    if (!data || !Array.isArray(data.items) || data.items.length > 100) fail("上游密钥列表响应无效", "supply_provisioning_invalid_response", 502);
    const matches = data.items.filter((raw) => record(raw)?.name === input.name || record(raw)?.key === input.customKey);
    if (matches.length > 1 || (matches.length && found)) fail("上游密钥匹配结果不唯一", "supply_provisioning_key_conflict", 409);
    if (matches.length === 1) found = confirmKey(matches[0], input, config, current.ownerId);
    const total = typeof data.total === "number" && Number.isSafeInteger(data.total) && data.total >= 0 ? data.total : null;
    if ((total !== null && page * 100 >= total) || (total === null && data.items.length < 100)) return { key: found, session: current };
  }
  fail("上游密钥列表超出核验范围，请检查服务账号", "supply_provisioning_list_limit", 503);
}

export async function provisionSub2ApiKey(input: ProvisionInput): Promise<ProvisionedSub2ApiKey> {
  validateInput(input);
  const config = await configuration();
  const session = await getSession(config);
  const existing = await findExisting(config, session, input);
  if (existing.key) return existing.key;
  let created: ProvisionedSub2ApiKey;
  let current = existing.session;
  try {
    const response = await authenticatedRequest(config, current, "/api/v1/keys", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({ name: input.name, custom_key: input.customKey, group_id: Number(config.groupId), quota: config.quota })
    });
    current = response.session;
    created = confirmKey(response.data, input, config, current.ownerId);
  } catch (error) {
    // A timeout or an idempotency replay may follow a successful creation. Read
    // the real record; never issue a second creation with a new key or name.
    if (!(error instanceof Sub2ApiProvisionError) || ["supply_provisioning_2fa_required", "supply_provisioning_auth_rejected", "supply_provisioning_inactive_owner", "supply_provisioning_invalid_session", "supply_provisioning_rate_limited", "supply_provisioning_key_count_exceeded", "supply_provisioning_group_forbidden"].includes(error.code)) throw error;
    try {
      const recovered = await findExisting(config, await getSession(config), input);
      if (recovered.key) return recovered.key;
    } catch { /* Retain the original sanitized failure. */ }
    throw error;
  }
  const confirmed = await findExisting(config, current, input);
  if (!confirmed.key || confirmed.key.id !== created.id) fail("上游尚未确认密钥创建结果，请使用原任务重试", "supply_provisioning_unconfirmed", 502);
  return confirmed.key;
}
