import { describe, expect, it } from "vitest";
import {
  pruneAdminVersionSnapshots,
  retentionPolicy,
  validateTenantDatasetSize
} from "@/lib/retention-policy";
import type { VersionSnapshot } from "@/lib/types/domain";

describe("retention policy", () => {
  it("rejects tenant datasets larger than 1000MB", () => {
    const error = validateTenantDatasetSize(retentionPolicy.tenantMaxDatasetBytes + 1);

    expect(error).toContain("超过租户端单次保存上限 1000MB");
  });

  it("keeps only the latest 12 versions per shop for admin rollback", () => {
    const versions = Array.from({ length: 15 }, (_, index) =>
      createVersion({
        id: `shop-a-version-${index}`,
        shopId: "shop-a",
        createdAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
      })
    );

    const pruned = pruneAdminVersionSnapshots(versions);

    expect(pruned).toHaveLength(12);
    expect(pruned.map((version) => version.id)).not.toContain("shop-a-version-0");
    expect(pruned[0].id).toBe("shop-a-version-14");
  });

  it("keeps only the 30 most recently active shops", () => {
    const versions = Array.from({ length: 31 }, (_, index) =>
      createVersion({
        id: `shop-${index}-version`,
        shopId: `shop-${index}`,
        createdAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
      })
    );

    const pruned = pruneAdminVersionSnapshots(versions);

    expect(new Set(pruned.map((version) => version.shopId)).size).toBe(30);
    expect(pruned.some((version) => version.shopId === "shop-0")).toBe(false);
  });
});

function createVersion(input: { id: string; shopId: string; createdAt: string }): VersionSnapshot {
  return {
    id: input.id,
    cycleId: "cycle-test",
    shopId: input.shopId,
    kind: "import",
    title: input.id,
    createdAt: input.createdAt,
    createdBy: "test",
    summary: "test"
  };
}
