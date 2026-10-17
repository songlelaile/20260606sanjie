import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/server-session", () => ({ getCurrentSession: async () => ({ tenantId: "list-entry-fixture" }) }));
vi.mock("@/lib/creative-entitlements", () => ({
  getCreativeAccessForSession: async () => ({ allowed: true }),
  UNAVAILABLE_CREATIVE_ACCESS: { allowed: false }
}));
vi.mock("@/components/creative/CreativeAccessGate", () => ({
  CreativeAccessGate: ({ children }: { children: React.ReactNode }) => children
}));
vi.mock("@/lib/model-gateway/catalog", () => ({ GATEWAY_PLANS: [] }));

import OperatingNetworkPage from "@/app/dashboards/operating-network/page";
import { CreativeStudio } from "@/components/creative/CreativeStudio";

describe("unified replica workspace website entries", () => {
  it("replaces the three legacy sidebar entries with one replica workspace", () => {
    const html = renderToStaticMarkup(createElement(CreativeStudio, { kind: "image" }));
    const labels = [...html.matchAll(/<span>([^<]+)<\/span>/g)].map(match => match[1]);
    expect(labels.slice(0, 6)).toEqual(["主图", "详情", "广告图", "爆款复刻", "案例裂变", "风格焕新"]);
    expect(html).not.toContain('aria-label="清单成图"');
    expect(html).not.toContain('aria-label="清单成详"');
    expect(html).not.toContain('aria-label="批量 SKU"');
    expect(html).not.toContain("参考成详");
  });

  it.each([
    ["mirror", "爆款复刻", "mode=mirror&amp;source=web"],
    ["list-main", "清单成图", "mode=main&amp;source=web&amp;layout=1"],
    ["reference", "清单成详", "mode=detail&amp;detailMode=reference&amp;source=detail-reference&amp;layout=1"],
    ["sku", "批量 SKU", "mode=sku&amp;source=web&amp;layout=1"],
    ["main", "主图", "mode=main&amp;source=web&amp;studio=1"],
    ["detail", "详情", "mode=detail&amp;source=web&amp;studio=1"]
  ])("preserves the %s workspace on direct access and refresh", async (surface, label, query) => {
    const page = await OperatingNetworkPage({ searchParams: Promise.resolve({ surface }) });
    const html = renderToStaticMarkup(page);
    expect(html).toContain(`title="${label}"`);
    expect(html).toContain(`promptlab.html?${query}`);
    if (["list-main", "reference", "sku"].includes(surface)) {
      expect(html).not.toContain(`aria-label="${label}"`);
    } else {
      expect(html).toContain('aria-current="page"');
    }
  });
});
