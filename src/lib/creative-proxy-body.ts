/** Both the declared and actual wire bodies are bounded before parsing/buffering. */
export const CREATIVE_PROXY_MAX_BYTES = 32 * 1024 * 1024;

export class CreativeProxyBodyLimitError extends Error {
  constructor() {
    super("Body exceeds creative proxy limit");
    this.name = "CreativeProxyBodyLimitError";
  }
}

export async function readCreativeProxyBody(
  source: Pick<Response, "body" | "headers">,
  maxBytes = CREATIVE_PROXY_MAX_BYTES,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(source.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void source.body?.cancel().catch(() => {});
    throw new CreativeProxyBodyLimitError();
  }
  signal?.throwIfAborted();
  if (!source.body) return new Uint8Array();
  const reader = source.body.getReader();
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new CreativeProxyBodyLimitError();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
