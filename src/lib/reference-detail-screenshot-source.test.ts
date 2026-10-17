import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const contract = require(resolve(root, "src/reference-detail-contract.js"));
const blueprint = require(resolve(root, "labs/image-prompt-lab/reference-detail-blueprint.js"));
const batch = require(resolve(root, "labs/image-prompt-lab/reference-detail-batch.js"));
const first = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4dwAAAAASUVORK5CYII=";
const second = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const capturedAt = "2026-10-12T00:00:00.000Z";
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("reference detail screenshot learning source", () => {
  it("preserves screenshot order and an immutable digest without inventing a product source", () => {
    const source = contract.createScreenshotSource([first, second, first], { capturedAt });
    expect(source.schema).toBe("REFERENCE_DETAIL_SCREENSHOT_SOURCE_V1");
    expect(source.source).toEqual({ sourceMode: "screenshots", capturedAt });
    expect(source.assets).toHaveLength(2);
    expect(source.orderedBlocks).toHaveLength(3);
    expect(source.orderedBlocks[0].assetIds).toEqual(source.orderedBlocks[2].assetIds);
    expect(source.orderedBlocks[0].blockId).not.toBe(source.orderedBlocks[2].blockId);
    expect(source.facts).toEqual([]);
    expect(source.assets.every((asset: { rightsStatus: string }) => asset.rightsStatus === "reference_only")).toBe(true);
    expect(Object.isFrozen(source.orderedBlocks[0])).toBe(true);
    expect(contract.validateSourceSnapshot(source)).toMatchObject({ ok: true, value: { snapshotId: source.snapshotId } });
    expect(contract.validate(source)).toMatchObject({ ok: true });
    expect(contract.createScreenshotSource([first, second, first], { capturedAt }).snapshotId).toBe(source.snapshotId);
    expect(contract.createScreenshotSource([second, first, first], { capturedAt }).snapshotId).not.toBe(source.snapshotId);
  });

  it("honestly projects the selected screenshots without claiming page range anchors", () => {
    const source = contract.createScreenshotSource([first, second], { capturedAt });
    const projected = contract.projectDetailImageSource(source);
    expect(projected).toMatchObject({ ok: true, code: "SCREENSHOT_SOURCE_READY", report: {
      boundaryContract: "ORDERED_REFERENCE_SCREENSHOTS_V1", sourceKind: "screenshots", detailScreenCount: 2, filteredBlockCount: 0
    } });
    expect(projected.snapshot.snapshotId).toBe(source.snapshotId);
    expect(source.evidence.every((evidence: { kind: string }) => evidence.kind === "user")).toBe(true);
  });

  it("supports working blueprint, strict V1 envelope and V2 structure projection", () => {
    const source = contract.createScreenshotSource([first, second], { capturedAt });
    expect(blueprint.diagnoseSourceMigration(source)).toMatchObject({ ok: true, code: "SCREENSHOT_SOURCE_ACCEPTED" });
    const working = blueprint.createWorkingBlueprint(source, { targetScreenCount: 5 });
    const envelope = blueprint.projectToContractEnvelope(working, source);
    expect(contract.createRevisionEnvelope(envelope.currentBlueprint, envelope.immediatePreviousBlueprint, source).currentBlueprint.sourceSnapshotId).toBe(source.snapshotId);
    const visual = contract.projectVisualStructureBlueprint(envelope.currentBlueprint, source, { previousBlueprint: envelope.immediatePreviousBlueprint });
    expect(contract.validateVisualStructureBlueprintAgainstSource(visual, source)).toMatchObject({ ok: true });
    expect(visual.claimMode).toBe("visual_structure_only");
    expect(visual.modules.every((module: { factBindings?: unknown[]; editableCopy?: unknown }) => !module.factBindings && !module.editableCopy)).toBe(true);
    const changed = contract.createScreenshotSource([second, first], { capturedAt });
    expect(contract.validateVisualStructureBlueprintAgainstSource(visual, changed)).toMatchObject({ ok: false, errors: [{ code: "SOURCE_SNAPSHOT_MISMATCH" }] });
  });

  it("rejects fact, brand, direct-use and order mutations of screenshot source records", () => {
    const original = contract.createScreenshotSource([first, second], { capturedAt });
    for (const mutate of [
      (value: any) => { value.facts.push({ value: "竞品价格" }); },
      (value: any) => { value.orderedBlocks[0].text = "竞品品牌"; },
      (value: any) => { value.assets[0].rightsStatus = "self_owned"; },
      (value: any) => { value.orderedBlocks.reverse(); },
      (value: any) => { value.source.itemId = "12345"; },
      (value: any) => { value.productFacts = [{ label: "竞品规格" }]; }
    ]) {
      const changed = clone(original);
      mutate(changed);
      expect(contract.validateSourceSnapshot(changed).ok).toBe(false);
    }
  });

  it("keeps screenshot pixels out of a confirmed V2 generation payload", () => {
    const source = contract.createScreenshotSource([first], { capturedAt });
    const working = blueprint.materializeScreenBlueprint(blueprint.createWorkingBlueprint(source), source, 5);
    const envelope = blueprint.projectToContractEnvelope(working, source);
    const draft = contract.projectVisualStructureBlueprint(envelope.currentBlueprint, source, { previousBlueprint: envelope.immediatePreviousBlueprint });
    const approved = contract.approveVisualStructureBlueprint(draft, source, { approvedAt: capturedAt, verificationId: "local_structure_confirmation" });
    const asset = { assetId: "own_subject", role: "subject", rightsStatus: "self_owned", evidenceId: "own_asset_confirmation" };
    const bundle = batch.validateExecutionBundle({
      schema: "REFERENCE_DETAIL_EXECUTION_BUNDLE_V2", schemaVersion: 2, claimMode: "visual_structure_only",
      sourceSnapshot: source, currentBlueprint: approved, immediatePreviousBlueprint: draft,
      verifiedTargetAssets: [asset], assetsById: { own_subject: { ...asset, ref: second } }
    });
    const target = batch.normalizeDraftTarget({ productName: "自家商品", internalId: "OWN-01", subjectAssetIds: [asset.assetId], userInput: {} });
    const projection = batch.createGenerationProjection(bundle, target, { screenCount: 5, reuseMode: "single_reference", generationVersion: 1 });
    expect(projection.screens).toHaveLength(5);
    expect(projection.referenceImage).toBe("");
    expect(projection.referenceImages).toEqual([]);
    expect(projection.visualTemplateImages).toEqual([]);
    expect(JSON.stringify(projection)).not.toContain(first);
    expect(projection.subjectAssets).toMatchObject([{ assetId: "own_subject", ref: second }]);
    expect(() => batch.assertGenerationPayloadSafe({ referenceImages: [first] }, bundle)).toThrow();
  });

  it("keeps retired upload fallback states rejected", () => {
    const source = clone(contract.createScreenshotSource([first], { capturedAt }));
    source.source.sourceMode = "upload_fallback";
    expect(blueprint.diagnoseSourceMigration(source)).toMatchObject({ ok: false, code: "LEGACY_REFERENCE_UPLOAD_REMOVED" });
    expect(() => blueprint.importSourceSnapshot(source)).toThrow();
    expect(blueprint.diagnoseSourceMigration({ schema: "REFERENCE_DETAIL_UPLOAD_SOURCE_V1", images: [first] })).toMatchObject({ ok: false, code: "LEGACY_REFERENCE_UPLOAD_REMOVED" });
  });

  it("bounds count, local image format, dimensions and payload size", () => {
    expect(() => contract.createScreenshotSource([], { capturedAt })).toThrow();
    expect(() => contract.createScreenshotSource(Array(7).fill(first), { capturedAt })).toThrow();
    expect(() => contract.createScreenshotSource(["https://example.com/image.png"], { capturedAt })).toThrow();
    expect(() => contract.createScreenshotSource([first.replace("image/png", "image/jpeg")], { capturedAt })).toThrow();
    expect(() => contract.createScreenshotSource([{ url: first, width: 5000, height: 9000 }], { capturedAt })).toThrow();
    const oversized = "data:image/png;base64," + "AAAA".repeat(Math.floor(contract.SCREENSHOT_LIMITS.maxImageBytes / 3) + 1);
    expect(contract.validateScreenshotImageUrl(oversized)).toMatchObject({ ok: false, code: "SCREENSHOT_IMAGE_TOO_LARGE" });
  });
});
