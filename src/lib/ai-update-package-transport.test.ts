import { gzipSync, gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createAiUpdatePackageEncoder } from "./ai-update-package-transport";

describe("AI package transport encoding", () => {
  it.each(["gzip", "br, gzip, deflate", "GZip ; Q=0.5", "*;q=0.8", "br;q=1, gzip;q=0.001"])("accepts negotiated gzip: %s", async (header) => {
    const input = Buffer.from("signed envelope bytes ".repeat(100));
    const result = await createAiUpdatePackageEncoder()(input, header);
    expect(result.headers).toEqual({ Vary: "Accept-Encoding", "Content-Encoding": "gzip" });
    expect(gunzipSync(result.body)).toEqual(input);
  });

  it.each([null, "", "br", "identity", "gzip;q=0", "*;q=0", "gzip;q=0, *;q=1", "gzip;q=1, gzip;q=0", "gzip;q=1.1", "gzip;q=bogus", "gzip;q=-1", "gzip;q=0.0001", "gzip;unexpected=1"])("leaves rejected or unspecified encoding untouched: %s", async (header) => {
    const compress = vi.fn(async (bytes: Buffer) => gzipSync(bytes));
    const input = Buffer.from("signed original bytes");
    const result = await createAiUpdatePackageEncoder(compress)(input, header);
    expect(result.body).toBe(input);
    expect(result.headers).toEqual({ Vary: "Accept-Encoding" });
    expect(compress).not.toHaveBeenCalled();
  });

  it("coalesces concurrent identical compression and invalidates on same-size content changes", async () => {
    const compress = vi.fn(async (bytes: Buffer) => gzipSync(bytes));
    const encode = createAiUpdatePackageEncoder(compress);
    const first = Buffer.from("original signed bytes");
    const changed = Buffer.from("modified signed bytes");
    expect(first.length).toBe(changed.length);
    const outputs = await Promise.all([encode(first, "gzip"), encode(Buffer.from(first), "gzip"), encode(first, "gzip")]);
    expect(compress).toHaveBeenCalledTimes(1);
    for (const output of outputs) expect(gunzipSync(output.body)).toEqual(first);
    expect(gunzipSync((await encode(changed, "gzip")).body)).toEqual(changed);
    expect(compress).toHaveBeenCalledTimes(2);
  });

  it("evicts old compressed entries instead of growing the cache across versions", async () => {
    const compress = vi.fn(async (bytes: Buffer) => gzipSync(bytes));
    const encode = createAiUpdatePackageEncoder(compress);
    for (let version = 0; version < 5; version++) await encode(Buffer.from("release " + version), "gzip");
    await encode(Buffer.from("release 4"), "gzip");
    expect(compress).toHaveBeenCalledTimes(5);
    await encode(Buffer.from("release 0"), "gzip");
    expect(compress).toHaveBeenCalledTimes(6);
  });

  it("limits distinct in-flight compression and releases a failed slot for retry", async () => {
    const releases: Array<() => void> = [];
    const compress = vi.fn(async (bytes: Buffer) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return gzipSync(bytes);
    });
    const encode = createAiUpdatePackageEncoder(compress);
    const requests = ["one", "two", "three"].map((text) => encode(Buffer.from(text), "gzip"));
    await vi.waitFor(() => expect(compress).toHaveBeenCalledTimes(2));
    releases[0]();
    await vi.waitFor(() => expect(compress).toHaveBeenCalledTimes(3));
    releases[1]();
    releases[2]();
    const results = await Promise.all(requests);
    expect(results.map(({ body }) => gunzipSync(body).toString())).toEqual(["one", "two", "three"]);

    const flaky = vi.fn().mockRejectedValueOnce(new Error("compression interrupted")).mockImplementation(async (bytes: Buffer) => gzipSync(bytes));
    const retry = createAiUpdatePackageEncoder(flaky);
    await expect(retry(Buffer.from("retry"), "gzip")).rejects.toThrow("compression interrupted");
    expect(gunzipSync((await retry(Buffer.from("retry"), "gzip")).body).toString()).toBe("retry");
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});
