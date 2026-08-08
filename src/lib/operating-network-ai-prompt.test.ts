import { describe, expect, it } from "vitest";
import { buildOperatingNetworkSnapshot } from "@/lib/operating-network";
import {
  buildOperatingNetworkAiPrompt,
  compactOperatingNetworkSnapshotForAi
} from "@/lib/operating-network-ai-prompt";

describe("operating network AI prompt", () => {
  it("keeps evidence boundaries while removing repeated presentation fields", () => {
    const snapshot = buildOperatingNetworkSnapshot({
      investmentResults: [],
      breakthroughResults: [],
      audiencePlans: []
    });
    const compact = compactOperatingNetworkSnapshotForAi(snapshot);
    const prompt = buildOperatingNetworkAiPrompt(snapshot);

    expect(compact.finding).toMatchObject({
      conclusion: snapshot.finding.conclusion,
      status: snapshot.finding.status,
      proof: snapshot.finding.proof,
      cannotProve: snapshot.finding.cannotProve
    });
    expect(compact.modelDataGaps.length).toBeGreaterThan(0);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(snapshot).length);
    expect(prompt).toContain("不能证明与待补数据");
    expect(prompt).toContain("不以同月类目市场数据为前置条件");
    expect(compact.modelDataGaps).not.toContain("同期市场表与店铺—市场类目稳定映射");
    expect(prompt).toContain("经营网络证据 JSON：\n{");
    expect(prompt).not.toContain("\n  \"");
  });
});
