import { describe, expect, it } from "vitest";
import { safeAuthReturnPath, safeCreativeReturnPath } from "./auth-return-path";

const IMAGE = "/dashboards/operating-network";
const REPORT = `/shared/dmp-reports/${"a".repeat(64)}`;

describe("safe creative login return paths", () => {
  it.each(["main", "detail", "reference", "sku", "viral", "viral-case", "viral-style", "viral-scene", "clothing", "buyer", "refinement"])(
    "allows the published %s module selector", (surface) => {
      expect(safeAuthReturnPath(`${IMAGE}?surface=${surface}`)).toBe(`${IMAGE}?surface=${surface}`);
    }
  );

  it("supports main, video and batch tasks with stable query ordering", () => {
    expect(safeAuthReturnPath(IMAGE)).toBe(IMAGE);
    expect(safeAuthReturnPath(`${IMAGE}/video`)).toBe(`${IMAGE}/video`);
    expect(safeAuthReturnPath(`${IMAGE}?batch=1`)).toBe(`${IMAGE}?batch=1`);
    expect(safeAuthReturnPath(`${IMAGE}?batch=1&surface=main`)).toBe(`${IMAGE}?surface=main&batch=1`);
  });

  it.each([
    undefined, null, "", "https://evil.example/", `https://shaozhuangai.com${IMAGE}`,
    `//evil.example${IMAGE}`, `/\\evil.example${IMAGE}`, `${IMAGE}#https://evil.example`,
    `${IMAGE}/extra`, `${IMAGE}/../management`, "/dashboards/%6fperating-network",
    `${IMAGE}?surface=main%0a`, `${IMAGE}?surface=main\u0000`, `${IMAGE}?surface=unknown`,
    `${IMAGE}?surface=`, `${IMAGE}?surface=main&surface=buyer`, `${IMAGE}?%73urface=main&surface=buyer`,
    `${IMAGE}?batch=1&batch=1`, `${IMAGE}?batch=0`, `${IMAGE}?batch=true`,
    `${IMAGE}?returnTo=https://evil.example`, `${IMAGE}?surface=main&apiKey=secret`,
    `${IMAGE}?contextToken=local-secret`, `${IMAGE}?mode=sku`, `${IMAGE}?source=plugin`,
    `${IMAGE}/video?surface=buyer`, `${IMAGE}/video?returnTo=${IMAGE}`, "/tools", "/management"
  ])("rejects non-whitelisted return path %s", (path) => {
    expect(safeCreativeReturnPath(path)).toBe("");
  });

  it("retains exact existing report token rules", () => {
    expect(safeAuthReturnPath(REPORT)).toBe(REPORT);
    expect(safeAuthReturnPath(`${REPORT}?next=${IMAGE}`)).toBe("");
    expect(safeAuthReturnPath(`/shared/dmp-reports/${"a".repeat(63)}`)).toBe("");
    expect(safeAuthReturnPath(`https://evil.example${REPORT}`)).toBe("");
    expect(safeCreativeReturnPath(REPORT)).toBe("");
  });
});
