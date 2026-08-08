import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

export interface SafeAiJsonResponse<T> {
  ok: boolean;
  status: number;
  payload: T | null;
}

/** 阻断 AI 自定义地址直连本机、内网、链路本地和云元数据网段。 */
export function isSafeAiEndpointUrl(value: string) {
  try {
    const url = new URL(value);
    // 经营摘要和 Bearer Key 只能通过 TLS 出站，避免明文中间人窃取。
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    const host = normalizeHost(url.hostname);
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
      return false;
    }
    return !isPrivateAddress(host);
  } catch {
    return false;
  }
}

export async function assertSafeAiEndpoint(value: string) {
  await resolveSafeAiEndpoint(value);
}

/**
 * 解析一次后把 HTTPS 连接固定到已验证的公网 IP，同时保留原 Host/SNI。
 * 这样 DNS 在校验与连接之间变化时，也不能把 Bearer Key 和经营摘要导向内网。
 */
export async function postJsonToSafeAiEndpoint<T>(
  value: string,
  input: { headers?: Record<string, string>; body: string; timeoutMs?: number; maxResponseBytes?: number }
): Promise<SafeAiJsonResponse<T>> {
  const target = await resolveSafeAiEndpoint(value);
  const maxResponseBytes = input.maxResponseBytes ?? 2 * 1024 * 1024;
  const signal = AbortSignal.timeout(input.timeoutMs ?? 45_000);
  const bodyBytes = Buffer.from(input.body, "utf8");
  const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: target.address,
        family: target.family,
        port: target.url.port ? Number(target.url.port) : 443,
        path: `${target.url.pathname}${target.url.search}`,
        method: "POST",
        servername: isIP(target.host) ? undefined : target.host,
        rejectUnauthorized: true,
        checkServerIdentity: (_hostname, certificate) => checkServerIdentity(target.host, certificate),
        signal,
        headers: {
          ...input.headers,
          host: target.url.host,
          "content-length": String(bodyBytes.byteLength),
          "accept-encoding": "identity"
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.byteLength;
          if (total > maxResponseBytes) {
            response.destroy(new Error("AI 服务响应超过安全大小限制"));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 502,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
        response.on("error", reject);
      }
    );
    request.on("error", reject);
    request.end(bodyBytes);
  });
  let payload: T | null = null;
  try {
    payload = JSON.parse(raw.body) as T;
  } catch {
    payload = null;
  }
  return { ok: raw.status >= 200 && raw.status < 300, status: raw.status, payload };
}

function normalizeHost(value: string) {
  return value.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
}

function isPrivateAddress(value: string) {
  const host = normalizeHost(value);
  if (isIP(host) === 6) return !isGlobalUnicastIpv6(host);
  const ipv4 = isIP(host) === 4 ? host : "";
  if (!ipv4) return false;
  const octets = ipv4.split(".").map(Number);
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function isGlobalUnicastIpv6(value: string) {
  const words = parseIpv6Words(value);
  if (!words) return false;
  // 只允许 2000::/3 的全球单播；自动排除 mapped、ULA、link-local、multicast 等。
  if (words[0] < 0x2000 || words[0] > 0x3fff) return false;
  // 文档、基准、ORCHID、Teredo 与 6to4 等特殊前缀不用于外部 AI API。
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
  if (words[0] === 0x2001 && words[1] === 0x0002 && words[2] === 0) return false;
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0010) return false;
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0020) return false;
  if (words[0] === 0x2001 && words[1] === 0) return false;
  if (words[0] === 0x2002) return false;
  if (words[0] === 0x3fff && (words[1] & 0xf000) === 0) return false;
  return true;
}

function parseIpv6Words(value: string): number[] | null {
  const parts = value.split("::");
  if (parts.length > 2) return null;
  const left = parseIpv6Side(parts[0]);
  const right = parts.length === 2 ? parseIpv6Side(parts[1]) : [];
  if (!left || !right) return null;
  if (parts.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

function parseIpv6Side(value: string): number[] | null {
  if (!value) return [];
  const result: number[] = [];
  for (const segment of value.split(":")) {
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) return null;
    result.push(Number.parseInt(segment, 16));
  }
  return result;
}

async function resolveSafeAiEndpoint(value: string) {
  if (!isSafeAiEndpointUrl(value)) {
    throw new Error("AI Base URL 必须使用 HTTPS，且不能指向本机、内网或链路本地地址");
  }
  const url = new URL(value);
  const host = normalizeHost(url.hostname);
  const literalFamily = isIP(host);
  if (literalFamily) return { url, host, address: host, family: literalFamily };
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => isPrivateAddress(normalizeHost(item.address)))) {
    throw new Error("AI Base URL 解析到了不允许访问的网络地址");
  }
  const selected = addresses[0];
  return { url, host, address: normalizeHost(selected.address), family: selected.family };
}
