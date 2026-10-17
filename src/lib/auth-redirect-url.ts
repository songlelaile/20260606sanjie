// Middleware runs on Edge: keep this helper free of Node and server-only imports.
const DEFAULT_AUTH_REDIRECT_ORIGIN = "https://shaozhuangai.com";

export function authRedirectUrl(requestUrl: Pick<URL, "origin" | "pathname" | "search">): URL {
  const production = process.env.NODE_ENV === "production";
  const raw = process.env.PUBLIC_APP_ORIGIN?.trim() ||
    (production ? DEFAULT_AUTH_REDIRECT_ORIGIN : requestUrl.origin);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PUBLIC_APP_ORIGIN 必须是有效的 http(s) 站点地址");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("PUBLIC_APP_ORIGIN 只允许 http(s) 协议");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_APP_ORIGIN 只能包含协议、域名与可选端口");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const localHostname =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname === "[::]" ||
    hostname === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (production && (url.protocol !== "https:" || localHostname)) {
    throw new Error("生产环境 PUBLIC_APP_ORIGIN 必须是非本机的 HTTPS 站点");
  }

  // Assign path/search separately so even a //-prefixed path cannot replace origin.
  url.pathname = requestUrl.pathname;
  url.search = requestUrl.search;
  return url;
}
