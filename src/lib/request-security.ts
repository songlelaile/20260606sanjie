import { authRedirectUrl } from "@/lib/auth-redirect-url";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const EXTENSION_API = /^\/api\/(?:dmp-reports(?:\/|$)|dmp-market-reports$|dmp-source-data(?:\/|$)|dmp-report-exports$|dmp-report-shares(?:\/|$)|dmp-runtime\/)/;

/** These endpoints authenticate an explicit key/token in their own handlers. */
export function usesExplicitApiCredential(pathname: string, headers: Headers): boolean {
  if (pathname.startsWith("/v1/") || pathname.startsWith("/api/v1/")) return true;
  return EXTENSION_API.test(pathname) && !!headers.get("x-sanjie-session")?.trim();
}

export function isExtensionApi(pathname: string): boolean {
  return EXTENSION_API.test(pathname);
}

/** Never derive a production trust boundary from client-controlled Host/XFF. */
export function isTrustedRequestOrigin(requestUrl: URL, origin: string): boolean {
  try {
    const supplied = new URL(origin);
    if (origin !== supplied.origin || supplied.username || supplied.password) return false;
    const trusted = authRedirectUrl(requestUrl).origin;
    if (supplied.origin === trusted) return true;
    // The existing website serves both names. Do not extend this to other subdomains.
    return (trusted === "https://shaozhuangai.com" || trusted === "https://www.shaozhuangai.com") &&
      (supplied.origin === "https://shaozhuangai.com" || supplied.origin === "https://www.shaozhuangai.com");
  } catch { return false; }
}

/** Browser mutations must originate at this website. CLI clients have no fetch metadata. */
export function rejectsCrossSiteMutation(request: Pick<Request, "url" | "method" | "headers">): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  const url = new URL(request.url);
  if (usesExplicitApiCredential(url.pathname, request.headers)) return false;
  const origin = request.headers.get("origin");
  if (origin !== null) return !isTrustedRequestOrigin(url, origin);
  // Modern browsers include Origin on mutations. A forged non-browser request still
  // has to pass authentication and account quotas; this signal is not bot detection.
  const site = request.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin";
}

/** Block source/debug/backup artifacts even under framework/static download paths. */
export function isPrivateSourcePath(pathname: string): boolean {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return true; }
  if (/[\\\x00-\x1f\x7f]/.test(decoded)) return true;
  return /(?:^|\/)\.(?:git|svn|hg|env)(?:[./]|$)/i.test(decoded) ||
    /^\/(?:node_modules|private-assets|prisma|src|scripts|security)(?:\/|$)/i.test(decoded) ||
    /\.(?:map|ts|tsx|sql|pem|key|sqlite3?|db|bak|backup|old|orig|log|tgz|tar|gz|7z)$/i.test(decoded) ||
    /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|AGENTS\.md|DEPLOY\.md|tsconfig\.json|next\.config\.[cm]?js)$/i.test(decoded);
}
