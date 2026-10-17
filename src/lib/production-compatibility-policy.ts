/** Existing production contracts, preserved by exact route matching only.
 * These exceptions never authenticate an AI grant outside its execute endpoint.
 * Public archives contain client code; retaining their update contract preserves
 * that exposure until existing installed clients can migrate together.
 */
const PUBLIC_AI_UPDATE_PATH = /^\/api\/tools\/updates\/ai-automation\/(?:latest|bootstrap|package\/(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){2,3})$/;
const VIDEO_SELF_AUTH_PATH = /^\/api\/(?:video-assets(?:\/(?:[A-Za-z0-9_-]{8,120}|source\/[a-f0-9]{32}))?|video-tasks(?:\/(?:[A-Za-z0-9_-]{8,120}|by-key\/[A-Za-z0-9_-]{8,120}))?)$/;
const VIDEO_VALIDATION_PATH = /^\/api\/video-assets\/validation-sessions\/[A-Za-z0-9_-]{8,120}(?:\/verify)?$/;
const SOWER_SELF_AUTH_PATH = /^\/api\/tools\/sower-work\/(?:access|lease(?:\/verify)?|download|update)$/;
const SOWER_ADMIN_GRANT_PATH = /^\/api\/managed-users\/[A-Za-z0-9_-]{1,128}\/sower-work-access$/;

// Existing retained and current AI ZIPs only. No wildcard product/version rule.
export const PUBLIC_AI_DOWNLOAD_PATHS = [
  "/downloads/sycm-keyword-collector-v1.9.80.zip",
  "/downloads/shaozhuang-ai-v1.9.80-macos-full.zip",
  "/downloads/sycm-keyword-collector-v1.9.83.zip",
  "/downloads/shaozhuang-ai-v1.9.83-macos-full.zip",
  "/downloads/sycm-keyword-collector-v1.9.84.zip",
  "/downloads/shaozhuang-ai-v1.9.84-macos-full.zip"
] as const;
const publicAiDownloads = new Set<string>(PUBLIC_AI_DOWNLOAD_PATHS);

export function isPublicAiDistributionPath(pathname: string): boolean {
  return PUBLIC_AI_UPDATE_PATH.test(pathname) || publicAiDownloads.has(pathname);
}

/** Route handlers own signed-session/lease/HMAC and current database checks.
 * Let their existing CORS/Origin policy run before generic website CSRF checks:
 * an extension Origin and a signed lease POST are valid existing client paths.
 */
export function isProductionSelfAuthenticatedPath(pathname: string): boolean {
  return VIDEO_SELF_AUTH_PATH.test(pathname) || VIDEO_VALIDATION_PATH.test(pathname) || SOWER_SELF_AUTH_PATH.test(pathname) ||
    pathname === "/api/admin/sower-work/users" || SOWER_ADMIN_GRANT_PATH.test(pathname);
}
