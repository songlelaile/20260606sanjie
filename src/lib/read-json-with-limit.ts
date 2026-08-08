export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`请求体超过 ${maxBytes} 字节限制`);
    this.name = "RequestBodyTooLargeError";
  }
}

/** 在 JSON.parse 前限制实际读取字节数，不能只信任可伪造或缺失的 Content-Length。 */
export async function readJsonWithLimit(request: Request, maxBytes: number): Promise<unknown | null> {
  const rawLength = request.headers.get("content-length");
  const declaredLength = rawLength ? Number(rawLength) : null;
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged)) as unknown;
  } catch {
    return null;
  }
}
