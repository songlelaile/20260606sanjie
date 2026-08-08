import { describe, expect, it } from "vitest";
import { isSafeAiEndpointUrl } from "@/lib/ai-endpoint";

describe("AI endpoint safety", () => {
  it.each([
    "http://127.0.0.1:3000/v1",
    "http://localhost/v1",
    "http://10.0.0.2/v1",
    "http://172.16.1.2/v1",
    "http://192.168.1.2/v1",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/v1",
    "http://example.com/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://[fe90::1]/v1",
    "https://[ff02::1]/v1",
    "https://[2001:db8::1]/v1",
    "file:///etc/passwd"
  ])("blocks private or non-http endpoint %s", (value) => {
    expect(isSafeAiEndpointUrl(value)).toBe(false);
  });

  it("allows a public HTTPS endpoint without embedded credentials", () => {
    expect(isSafeAiEndpointUrl("https://api.deepseek.com/v1")).toBe(true);
    expect(isSafeAiEndpointUrl("https://[2606:4700:4700::1111]/v1")).toBe(true);
    expect(isSafeAiEndpointUrl("https://user:secret@example.com/v1")).toBe(false);
  });
});
