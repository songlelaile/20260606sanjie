import { describe, expect, it } from "vitest";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";

describe("bounded JSON body reader", () => {
  it("parses a body within the actual byte limit", async () => {
    const request = new Request("http://localhost/source", {
      method: "POST",
      body: JSON.stringify({ ok: true })
    });
    await expect(readJsonWithLimit(request, 64)).resolves.toEqual({ ok: true });
  });

  it("rejects oversized declared or streamed bodies", async () => {
    const declared = new Request("http://localhost/source", {
      method: "POST",
      headers: { "content-length": "100" },
      body: "{}"
    });
    const actual = new Request("http://localhost/source", {
      method: "POST",
      body: JSON.stringify({ value: "x".repeat(100) })
    });
    await expect(readJsonWithLimit(declared, 32)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    await expect(readJsonWithLimit(actual, 32)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});
