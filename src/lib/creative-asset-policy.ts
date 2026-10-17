/** Static files needed by the creative workspaces; documentation and source maps are never served. */
const MIME_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf"
};

export const CREATIVE_ASSET_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": "frame-ancestors 'self'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow, noarchive"
};

export function creativeAssetContentType(parts: readonly string[] | undefined): string | null {
  if (!Array.isArray(parts) || !parts.length || parts.some(part =>
    typeof part !== "string" || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) ||
    /^(?:fixtures?|tests?|__tests__|backups?|docs?|debug)$/i.test(part) ||
    /(?:^|[._-])(?:test|spec|backup|bak|old|debug|map)(?:[._-]|$)/i.test(part)
  )) return null;
  const filename = parts.at(-1)!;
  if (/^(?:readme|manifest)(?:\.|$)/i.test(filename)) return null;
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  return MIME_TYPES[extension] ?? null;
}
