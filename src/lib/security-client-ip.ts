import "server-only";
import { isIP } from "node:net";

/**
 * Enable only behind an ingress that overwrites X-Real-IP and blocks direct
 * upstream access. Never trust client-supplied X-Forwarded-For chains.
 */
export function trustedClientIp(request: Request): string | null {
  if (process.env.SANJIE_TRUST_PROXY_IP !== "true") return null;
  const candidate = request.headers.get("x-real-ip")?.trim() ?? "";
  if (isIP(candidate) === 4) return candidate;
  if (isIP(candidate) === 6) {
    try { return new URL(`http://[${candidate}]/`).hostname.slice(1, -1); } catch { return null; }
  }
  return null;
}
