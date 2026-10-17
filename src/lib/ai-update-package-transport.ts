import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
const MAX_CACHE_ENTRIES = 4;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSIONS = 2;

function acceptsGzip(header: string | null) {
  if (!header) return false;
  let explicit: number | undefined;
  let wildcard: number | undefined;
  for (const item of header.split(",")) {
    const [name, ...parameters] = item.trim().toLowerCase().split(";").map((part) => part.trim());
    if (name !== "gzip" && name !== "*") continue;
    let quality = 1;
    if (parameters.length) {
      const match = parameters.length === 1 && /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.exec(parameters[0]);
      quality = match ? Number(match[1]) : 0;
    }
    // An explicit rejection takes precedence over wildcard or duplicate entries.
    if (name === "gzip") explicit = Math.min(explicit ?? 1, quality);
    else wildcard = Math.min(wildcard ?? 1, quality);
  }
  return (explicit ?? wildcard ?? 0) > 0;
}

type Compressor = (bytes: Buffer) => Promise<Buffer>;

/** Only caches transport bytes; callers must validate the original artifact on every request. */
export function createAiUpdatePackageEncoder(compress: Compressor = (bytes) => gzipAsync(bytes)) {
  const cache = new Map<string, Buffer>();
  const pending = new Map<string, Promise<Buffer>>();
  let cachedBytes = 0;

  async function compressed(bytes: Buffer) {
    // Content identity prevents stale output if a file changes without changing size.
    const key = createHash("sha256").update(bytes).digest("hex");
    for (;;) {
      const cached = cache.get(key);
      if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return cached;
      }
      const active = pending.get(key);
      if (active) return active;
      if (pending.size < MAX_COMPRESSIONS) break;
      await Promise.race(pending.values()).catch(() => undefined);
    }
    const flight = Promise.resolve().then(() => compress(bytes)).then((body) => {
      if (body.length <= MAX_CACHE_BYTES) {
        while (cache.size >= MAX_CACHE_ENTRIES || cachedBytes + body.length > MAX_CACHE_BYTES) {
          const oldest = cache.keys().next().value!;
          cachedBytes -= cache.get(oldest)!.length;
          cache.delete(oldest);
        }
        cache.set(key, body);
        cachedBytes += body.length;
      }
      return body;
    }).finally(() => { pending.delete(key); });
    pending.set(key, flight);
    return flight;
  }

  return async (bytes: Buffer, acceptEncoding: string | null) => {
    const headers: Record<string, string> = { Vary: "Accept-Encoding" };
    if (!acceptsGzip(acceptEncoding)) return { body: bytes, headers };
    const body = await compressed(bytes);
    headers["Content-Encoding"] = "gzip";
    return { body, headers };
  };
}

export const encodeAiUpdatePackage = createAiUpdatePackageEncoder();
