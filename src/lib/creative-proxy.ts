export type ProxyDecision = { ok: true } | { ok: false; status: number; error: string };

const WRITE_HOSTS = new Set([
  "sub.shaozhuangai.com",
  "api.openai.com",
  "api.deepseek.com",
  "api.minimax.io",
  "api.minimax.chat",
  "ark.cn-beijing.volces.com",
  "dashscope.aliyuncs.com",
  "generativelanguage.googleapis.com",
  "open.bigmodel.cn"
]);

const READ_HOST_SUFFIXES = [
  ".volces.com",
  ".volccdn.com",
  ".byteimg.com",
  ".bytecdn.cn",
  ".aliyuncs.com",
  ".myqcloud.com",
  ".qpic.cn",
  ".googleusercontent.com",
  ".openai.com",
  ".oaistatic.com"
];

function isPrivateIp(address: string) {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  if (normalized.includes(":")) return true;
  const parts = normalized.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function hostAllowed(hostname: string, method: string) {
  const host = hostname.toLowerCase();
  if (WRITE_HOSTS.has(host)) return true;
  if (method === "GET" || method === "HEAD") {
    return READ_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  }
  return false;
}

export function evaluateCreativeProxy(urlString: string, methodInput: string): ProxyDecision {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { ok: false, status: 400, error: "上游地址无效。" };
  }
  const method = methodInput.toUpperCase();
  if (!["GET", "HEAD", "POST", "DELETE"].includes(method)) {
    return { ok: false, status: 405, error: "这个上游方法不允许转发。" };
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return { ok: false, status: 400, error: "只转发不带内嵌凭据的 HTTPS 上游。" };
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    isPrivateIp(hostname)
  ) {
    return { ok: false, status: 403, error: "内网地址不能通过网站转发。" };
  }
  if (!hostAllowed(hostname, method)) {
    return { ok: false, status: 403, error: "这个上游不在作图和视频允许的服务商名单里。" };
  }
  return { ok: true };
}

export function assertResolvedAddresses(addresses: string[]): ProxyDecision {
  for (const address of addresses) {
    if (isPrivateIp(address)) {
      return { ok: false, status: 403, error: "上游解析到了内网地址，已停止转发。" };
    }
  }
  return { ok: true };
}
