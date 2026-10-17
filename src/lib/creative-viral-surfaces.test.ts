import { describe, expect, it } from "vitest";
import { CREATIVE_VIRAL_SURFACES, isDedicatedViralSurface } from "./creative-viral-surfaces";

describe("dedicated viral entry contract", () => {
  it("gives every page a unique pinned route while retaining the existing viral engine", () => {
    expect(new Set(CREATIVE_VIRAL_SURFACES.map((item) => item.id)).size).toBe(3);
    expect(new Set(CREATIVE_VIRAL_SURFACES.map((item) => item.src)).size).toBe(3);
    for (const surface of CREATIVE_VIRAL_SURFACES) {
      const query = new URL(surface.src, "https://fixture.invalid").searchParams;
      expect(query.get("mode")).toBe("viral");
      expect(query.get("source")).toBe("web");
      expect(query.get("layout")).toBe("1");
      expect(query.get("workflow")).toBe("1");
      expect(query.get("creativeRoute")).toBe(surface.route);
      expect(isDedicatedViralSurface(surface.id)).toBe(true);
    }
    expect(isDedicatedViralSurface("viral")).toBe(false);
    expect(isDedicatedViralSurface("clothing")).toBe(false);
  });
});
