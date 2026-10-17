import "server-only";

export type SupplyCredential = { id: string; apiKey: string };
export type SupplyCredentials = { primary: SupplyCredential; backup: SupplyCredential | null };

const AUTHENTICATION_REJECTIONS = new Set(["invalid_api_key", "invalid_key", "api_key_invalid", "api_key_expired", "api_key_disabled"]);
// Sub2API commit 5106065716e494204fc0e8db16f68f6e9d576be0 api_key_auth.go rejects these before invoking the paid handler.
const SUB2API_AUTHENTICATION_REJECTIONS = new Set(["INVALID_API_KEY", "API_KEY_DISABLED"]);
const ACCEPTANCE_FIELDS = new Set(["id", "request_id", "task_id", "data", "choices", "video", "usage", "output", "result", "results", "task", "job", "image", "images"]);
const ACCEPTED_STATES = new Set(["accepted", "submitted", "queued", "pending", "processing", "running", "completed", "succeeded", "done"]);
const MAX_AUTH_ERROR_BYTES = 16 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasAcceptanceFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasAcceptanceFields);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, item]) => {
    const name = key.toLowerCase();
    return ACCEPTANCE_FIELDS.has(name) ||
      (["status", "task_status"].includes(name) && typeof item === "string" && ACCEPTED_STATES.has(item.toLowerCase())) ||
      (["accepted", "submitted", "providersubmitted", "provider_submitted", "success"].includes(name) && item === true) ||
      hasAcceptanceFields(item);
  });
}

/** A transport failure or a general HTTP error does not prove that a paid task was rejected. */
export async function isDefinitiveSupplyAuthenticationRejection(response: Response): Promise<boolean> {
  if (![401, 403].includes(response.status) || !/json/i.test(response.headers.get("content-type") || "")) return false;
  if (Number(response.headers.get("content-length") || 0) > MAX_AUTH_ERROR_BYTES || !response.body) return false;
  const reader = response.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_AUTH_ERROR_BYTES) {
        void reader.cancel().catch(() => undefined);
        return false;
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!object(body) || hasAcceptanceFields(body)) return false;
    // api_key_auth.go:223,229 uses this exact top-level 403 for an expired Key.
    // Wallet, subscription, inactive-account and other 403 responses are excluded.
    if (response.status === 403) return body.code === "API_KEY_EXPIRED" && typeof body.message === "string" &&
      Object.keys(body).every(key => ["code", "message"].includes(key));
    if (typeof body.code === "string" && SUB2API_AUTHENTICATION_REJECTIONS.has(body.code)) return true;
    return object(body.error) && typeof body.error.code === "string" && AUTHENTICATION_REJECTIONS.has(body.error.code);
  } catch { return false; }
  finally { reader.releaseLock(); }
}

/** At most one backup dispatch; only the final response may reach settlement. */
export async function runSupplyWithFailover(
  credentials: SupplyCredentials,
  send: (credential: SupplyCredential) => Promise<Response>
): Promise<{ response: Response; credentialId: string; attempts: number }> {
  const first = credentials.primary.apiKey ? credentials.primary : credentials.backup;
  if (!first?.apiKey) throw new Error("Supply credentials unavailable");
  const response = await send(first);
  const backup = credentials.backup;
  if (first === credentials.primary && backup?.apiKey && backup.id !== first.id &&
    await isDefinitiveSupplyAuthenticationRejection(response)) {
    void response.body?.cancel().catch(() => undefined);
    return { response: await send(backup), credentialId: backup.id, attempts: 2 };
  }
  return { response, credentialId: first.id, attempts: 1 };
}

export function redactSupplySecrets(value: unknown, keys: readonly string[]): unknown {
  if (typeof value === "string") return keys.filter(Boolean).reduce((text, key) => text.split(key).join("[redacted]"), value);
  if (Array.isArray(value)) return value.map((item) => redactSupplySecrets(item, keys));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactSupplySecrets(key, keys) as string, redactSupplySecrets(item, keys)]));
  return value;
}
