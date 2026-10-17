import "server-only";
import { parseSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createWebsiteHandler } from "./video-assets-r51/site-adapter.cjs";
import { getNativeVideoCreateSupply, type NativeVideoSupply } from "./model-gateway/native-video-supply";
import type { NativeVideoOwner } from "./model-gateway/native-video-contract";
import { createHash } from "node:crypto";

// CommonJS service stays server-only. No configuration or secret is serialized.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readConfiguration, readSecret } = require("./video-assets-r51/site-adapter.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRuntime } = require("./video-assets-r51/runtime.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createSessionAuthenticator } = require("./video-assets-r51/provider-resolver.cjs");
type AssetScope = { tenantId: string; userId: string; providerAccountId: string; projectName: string };
type AssetRuntime = {
  requestResolver: { resolve(identity: object, selection: object): Promise<AssetScope> };
  bindingResolver: { resolve(scope: AssetScope): Promise<{ mode: string }> };
  assetService: {
    resolveReferences(scope: AssetScope, ids: string[]): Promise<Array<{ id: string; url: string }>>;
    acquireLease(scope: AssetScope, input: { taskId: string; assetIds: string[] }): Promise<{ references: Array<{ id: string; url: string }> }>;
    releaseLease(scope: AssetScope, input: { taskId: string; terminalStatus: string }): Promise<unknown>;
  };
};
const lookupUser = (username: string) => prisma.user.findUnique({
  where: { username }, select: { id: true, username: true, tenantId: true, authRole: true, status: true }
});

// No credentials or tenant defaults are compiled into the client or route.
const baseHandler = createWebsiteHandler({
  prisma,
  verifySessionToken: parseSession,
  lookupUser
});
const authenticateAssetRequest = createSessionAuthenticator({ verifySessionToken: parseSession, lookupUser });

function selection(supply: NativeVideoSupply) {
  if (supply.kind !== "ark") throw new Error("Asset supplier unavailable");
  const apiOrigin = new URL(supply.endpoint).origin;
  return { provider: "doubao", apiOrigin, credentialFingerprint: createHash("sha256").update(apiOrigin + "\n" + supply.key).digest("hex") };
}
export async function handleVideoAssets(request: Request) {
  let selected;
  try { const raw = request.headers.get("x-video-binding"); selected = raw && JSON.parse(decodeURIComponent(raw)); }
  catch { return baseHandler(request); }
  try {
    if (selected?.native === true && selected.provider === "shaozhuang-native") {
      try { await authenticateAssetRequest(request); }
      catch { return Response.json({ ok: false, error: { code: "AUTH_REQUIRED", message: "请重新登录。" } }, { status: 401, headers: { "Cache-Control": "private, no-store" } }); }
      const headers = new Headers(request.headers);
      headers.set("x-video-binding", encodeURIComponent(JSON.stringify(selection(await getNativeVideoCreateSupply()))));
      // The service still checks the signed session, current user, explicit
      // platform grant and exact API key/project. No browser key is trusted.
      headers.set("x-video-platform-binding", "1");
      return baseHandler(new Request(request, { headers }));
    }
    return baseHandler(request);
  } catch {
    return Response.json({ ok: false, error: { code: "ASSET_SERVICE_NOT_CONFIGURED", message: "当前账号自动报备尚未配置。" } }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}

/** Called only with the native video's authenticated owner and server supply. */
export async function nativeAssetContext(owner: NativeVideoOwner, supply: NativeVideoSupply) {
  const configuration = await readConfiguration();
  if (!configuration) throw new Error("Asset service unavailable");
  const runtime: AssetRuntime = await createRuntime({ prisma, verifySessionToken: parseSession, lookupUser,
    configuration, sourceDirectory: process.env.VIDEO_ASSET_SOURCE_DIRECTORY, secretValue: readSecret });
  const scope = await runtime.requestResolver.resolve({ tenantId: owner.tenantId, userId: owner.id, accountKey: `${owner.tenantId}:${owner.username}` }, selection(supply));
  const binding = await runtime.bindingResolver.resolve(scope);
  if (!binding || binding.mode !== "platform") throw new Error("Platform asset grant required");
  return { scope, service: runtime.assetService };
}

/** Admin readiness contains booleans/counts only, never values, paths or IDs. */
export async function videoAssetConfigurationStatus() {
  let config: { accounts: Array<Record<string, unknown>>; grants: Array<Record<string, unknown>>; sourceSigningKeyRef?: string; validationCallbackUrl?: string } | null = null;
  let configurationValid = false;
  try { config = await readConfiguration(); configurationValid = !!config; } catch { /* Report no private parser details. */ }
  const readySecret = (ref: unknown) => typeof ref === "string" && /^[A-Z][A-Z0-9_]{2,119}$/.test(ref) && !ref.startsWith("NEXT_PUBLIC_") && !!process.env[ref]?.trim();
  const accounts = config?.accounts || [];
  let databaseReady = false;
  try { const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass('public.video_asset_binding_state') IS NOT NULL AS present`; databaseReady = rows[0]?.present === true; } catch { /* No SQL in the UI. */ }
  let callbackReady = false;
  try { const url = new URL(config?.validationCallbackUrl || ""); callbackReady = url.protocol === "https:" && ["www.shaozhuangai.com", "shaozhuangai.com"].includes(url.hostname) && url.pathname === "/api/video-assets/validation-callback" && !url.username && !url.password && !url.search && !url.hash; } catch { /* Missing callback. */ }
  return { configurationValid, databaseReady, sourceDirectoryConfigured: !!process.env.VIDEO_ASSET_SOURCE_DIRECTORY,
    sourceSigningKeyConfigured: readySecret(config?.sourceSigningKeyRef), callbackReady,
    accountCount: accounts.length, enabledAccountCount: accounts.filter(a => a.enabled === true).length,
    credentialsConfiguredCount: accounts.filter(a => [a.accessKeyIdRef, a.secretAccessKeyRef, a.apiKeyRef].every(readySecret)).length,
    grantCount: config?.grants?.length || 0 };
}
