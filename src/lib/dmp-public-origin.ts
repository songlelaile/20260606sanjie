import "server-only";

const DEFAULT_PUBLIC_APP_ORIGIN = "https://shaozhuangai.com";

export function getPublicAppOrigin() {
  const raw = process.env.PUBLIC_APP_ORIGIN?.trim() || DEFAULT_PUBLIC_APP_ORIGIN;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("PUBLIC_APP_ORIGIN 必须是有效的 http(s) 站点地址");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("PUBLIC_APP_ORIGIN 只允许 http(s) 协议");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("PUBLIC_APP_ORIGIN 只能包含协议、域名与可选端口");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const localHostname =
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (process.env.NODE_ENV === "production" && (parsed.protocol !== "https:" || localHostname)) {
    throw new Error("生产环境 PUBLIC_APP_ORIGIN 必须是非本机的 HTTPS 站点");
  }
  return parsed.origin;
}

export function toPublicAppUrl(pathname: string) {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) {
    throw new Error("公开站点路径必须是站内绝对路径");
  }
  return new URL(pathname, `${getPublicAppOrigin()}/`).toString();
}

export function toOfficialDmpReportUrl(reportId: string) {
  const clean = String(reportId ?? "").trim();
  if (!/^[a-z\d_-]{6,128}$/i.test(clean)) throw new Error("官网报告编号无效");
  const query = new URLSearchParams({ reportId: clean, view: "report" });
  return toPublicAppUrl(`/tools/dmp-report?${query.toString()}`);
}
