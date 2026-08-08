const DEV_FALLBACK_SECRET = "sanjie-dev-insecure-secret-change-me";

interface KeyEnvironment {
  NODE_ENV?: string;
  AI_API_ENCRYPTION_KEY?: string;
  SHARE_ENCRYPTION_KEY?: string;
  SESSION_SECRET?: string;
}

/** AI 凭据在生产环境必须使用独立密钥，不能回落到会话/分享密钥。 */
export function resolveAiEncryptionKeySource(env: KeyEnvironment = process.env): string {
  const dedicated = env.AI_API_ENCRYPTION_KEY?.trim() ?? "";
  if (env.NODE_ENV === "production") {
    if (
      dedicated.length < 32 ||
      dedicated === DEV_FALLBACK_SECRET ||
      dedicated.toLowerCase().startsWith("change-me-") ||
      dedicated === env.SHARE_ENCRYPTION_KEY?.trim() ||
      dedicated === env.SESSION_SECRET?.trim()
    ) {
      throw new Error(
        "AI_API_ENCRYPTION_KEY 未安全配置：生产环境必须使用独立的高强度随机值（建议 openssl rand -hex 32）。"
      );
    }
    return dedicated;
  }
  return dedicated || env.SHARE_ENCRYPTION_KEY || env.SESSION_SECRET || DEV_FALLBACK_SECRET;
}
