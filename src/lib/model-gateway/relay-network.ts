import "server-only";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

/** Error messages contain no upstream response, URL credentials or API key. */
export class RelayNetworkError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RelayNetworkError";
  }
}

export function isPublicRelayAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(value) === 4) {
    const [a, b, c] = value.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(value) === 6) {
    // Permit global unicast only. Translation/tunnel ranges can conceal a private IPv4 target.
    const parts = value.split(":");
    const first = Number.parseInt(parts[0], 16);
    const second = Number.parseInt(parts[1] || "0", 16);
    return first >= 0x2000 && first <= 0x3fff &&
      !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) && first !== 0x2002;
  }
  return false;
}

function checkedRelayUrl(raw: string, allowQuery = false): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new RelayNetworkError("中转站 Base URL 无效"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (!allowQuery && url.search)) {
    throw new RelayNetworkError("中转站仅支持不含凭据、查询参数或片段的 HTTPS 公共地址");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || /\.(?:localhost|local|internal|invalid|test)$/.test(host) ||
    (isIP(host) !== 0 && !isPublicRelayAddress(host))) {
    throw new RelayNetworkError("中转站地址必须使用公共网络地址");
  }
  return url;
}

export function normalizeRelayBaseUrl(raw: string): string {
  const input = raw.trim();
  const url = checkedRelayUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  url.pathname = url.pathname.replace(/\/+$/, "") || "/v1";
  return url.toString().replace(/\/+$/, "");
}

/** Resolve all answers before dispatch, then connect to that checked IP without a second DNS lookup. */
export async function assertPublicRelayUrl(raw: string, allowQuery = false) {
  const url = checkedRelayUrl(raw, allowQuery);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  } catch { throw new RelayNetworkError("中转站域名解析失败，请检查地址", 502); }
  if (!addresses.length || addresses.some((item) => !isPublicRelayAddress(item.address))) {
    throw new RelayNetworkError("中转站域名解析到了非公共地址，连接已拒绝");
  }
  return { url, address: addresses[0] };
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal, error: () => RelayNetworkError): Promise<T> {
  if (signal.aborted) return Promise.reject(error());
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(error()); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (reason: unknown) => { signal.removeEventListener("abort", abort); reject(reason); });
  });
}

/** HTTPS-only, redirect-free transport with pinned DNS and a streaming response. */
export async function relayFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal || AbortSignal.timeout(30_000);
  const abortError = () => signal.reason?.name === "TimeoutError"
    ? new RelayNetworkError("中转站连接超时，请稍后重试", 504) : new RelayNetworkError("中转站请求已取消", 499);
  if (signal.aborted) throw abortError();
  const { url, address } = await withAbort(assertPublicRelayUrl(raw, true), signal, abortError);
  if (signal.aborted) throw abortError();
  const headers = new Headers(init.headers);
  // Host is always derived from the validated target; callers cannot redirect the request using a header.
  headers.delete("host");
  headers.delete("connection");
  let body: Uint8Array | undefined;
  if (init.body != null) {
    const prepared = new Response(init.body);
    const contentType = prepared.headers.get("content-type");
    if (contentType && !headers.has("content-type")) headers.set("content-type", contentType);
    body = new Uint8Array(await withAbort(prepared.arrayBuffer(), signal, abortError));
    headers.set("content-length", String(body.byteLength));
  }
  return new Promise<Response>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    let settled = false;
    const req = httpsRequest(url, {
      method: init.method || "GET",
      headers: Object.fromEntries(headers),
      // TLS verifies the original hostname while the socket uses the checked address.
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      family: address.family,
      agent: false
    }, (upstream) => {
      const status = upstream.statusCode || 502;
      if (status >= 300 && status < 400) {
        upstream.destroy();
        req.destroy();
        settled = true;
        reject(new RelayNetworkError("中转站返回了重定向，请直接配置最终 HTTPS Base URL", 502));
        return;
      }
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (value != null && !["connection", "transfer-encoding", "keep-alive"].includes(name)) {
          responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      settled = true;
      const emptyBody = init.method === "HEAD" || [204, 205, 304].includes(status);
      resolve(new Response(emptyBody ? null : Readable.toWeb(upstream) as ReadableStream<Uint8Array>, {
        status, headers: responseHeaders
      }));
      if (emptyBody) upstream.resume();
    });
    const abort = () => req.destroy(abortError());
    signal.addEventListener("abort", abort, { once: true });
    req.on("close", () => {
      signal.removeEventListener("abort", abort);
    });
    req.on("error", (error) => {
      if (!settled) reject(error instanceof RelayNetworkError ? error : new RelayNetworkError("中转站连接失败，请检查网络和 Base URL", 502));
    });
    if (body) req.write(body);
    req.end();
  });
}
