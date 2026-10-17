import { NextResponse } from "next/server";
import type { SecurityRateLimitResult } from "@/lib/security-rate-limit";

export function securityRateLimitResponse(result: SecurityRateLimitResult): NextResponse | null {
  if (result.allowed) return null;
  const unavailable = result.reason === "unavailable";
  return NextResponse.json({
    error: unavailable ? "安全验证暂不可用，请稍后重试" : "操作过于频繁，请稍后重试",
    code: unavailable ? "SECURITY_UNAVAILABLE" : "RATE_LIMITED"
  }, { status: unavailable ? 503 : 429, headers: {
    "Cache-Control": "private, no-store",
    "Retry-After": String(result.retryAfterSeconds),
    "X-Content-Type-Options": "nosniff"
  } });
}
