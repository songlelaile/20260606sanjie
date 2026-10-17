import { describe, expect, it } from "vitest";
import { isProductionSelfAuthenticatedPath, isPublicAiDistributionPath, PUBLIC_AI_DOWNLOAD_PATHS } from "./production-compatibility-policy";

describe("existing production update contracts", () => {
  it("publishes only the six exact retained and current official ZIP paths", () => {
    expect(PUBLIC_AI_DOWNLOAD_PATHS).toEqual([
      "/downloads/sycm-keyword-collector-v1.9.80.zip",
      "/downloads/shaozhuang-ai-v1.9.80-macos-full.zip",
      "/downloads/sycm-keyword-collector-v1.9.83.zip",
      "/downloads/shaozhuang-ai-v1.9.83-macos-full.zip",
      "/downloads/sycm-keyword-collector-v1.9.84.zip",
      "/downloads/shaozhuang-ai-v1.9.84-macos-full.zip"
    ]);
  });
  it.each([
    "/api/tools/updates/ai-automation/latest", "/api/tools/updates/ai-automation/bootstrap",
    "/api/tools/updates/ai-automation/package/1.9.80", "/api/tools/updates/ai-automation/package/1.9.83",
    "/api/tools/updates/ai-automation/package/1.9.60.1", ...PUBLIC_AI_DOWNLOAD_PATHS
  ])("preserves reviewed public path %s", path => expect(isPublicAiDistributionPath(path)).toBe(true));
  it.each([
    "/api/tools/updates/dmp-collector/latest", "/api/tools/updates/dmp-collector/bootstrap",
    "/api/tools/updates/dmp-collector/package/2.3.61", "/api/tools/updates/ai-automation/latest/extra",
    "/api/tools/updates/ai-automation/package/01.9.83", "/api/tools/updates/ai-automation/package/1.9",
    "/api/tools/updates/ai-automation/package/1.9.83.1.1", "/api/tools/updates/ai-automation/package/1.9.83/extra",
    "/downloads/sycm-keyword-collector-v1.9.85.zip", "/downloads/shaozhuang-ai-v1.9.85-macos-full.zip",
    "/downloads/sycm-keyword-collector-v1.9.61.zip",
    "/downloads/sycm-keyword-collector-v1.9.84.zip/extra", "/downloads/shaozhuang-ai-v1.9.84-macos-full.zip/extra",
    "/downloads/nested/sycm-keyword-collector-v1.9.84.zip", "/downloads/SYCM-keyword-collector-v1.9.84.zip",
    "/downloads/shaozhuang-ai-v1.9.83-macos-full.zip/extra", "/downloads/private.zip",
    "/downloads/nested/sycm-keyword-collector-v1.9.83.zip", "/downloads/SYCM-keyword-collector-v1.9.83.zip"
  ])("does not widen public matching for %s", path => expect(isPublicAiDistributionPath(path)).toBe(false));
});

describe("precise production routes with their own authentication", () => {
  it.each([
    "/api/video-assets", "/api/video-assets/asset_abcdefgh", "/api/video-assets/source/" + "a".repeat(32),
    "/api/video-tasks", "/api/video-tasks/task_abcdefgh", "/api/video-tasks/by-key/request_abcdefgh",
    "/api/tools/sower-work/access", "/api/tools/sower-work/lease", "/api/tools/sower-work/lease/verify",
    "/api/tools/sower-work/download", "/api/tools/sower-work/update", "/api/admin/sower-work/users",
    "/api/managed-users/user_a/sower-work-access"
  ])("delegates exact route %s", path => expect(isProductionSelfAuthenticatedPath(path)).toBe(true));
  it.each([
    "/api/video-assets/source/" + "a".repeat(31), "/api/video-assets/source/" + "g".repeat(32),
    "/api/video-assets/short", "/api/video-assets/asset_abcdefgh/extra", "/api/video-assets/by-key/request_abcdefgh",
    "/api/video-tasks/source/" + "a".repeat(32), "/api/video-tasks/by-key/short",
    "/api/tools/sower-work/grant", "/api/tools/sower-work/lease/verify/extra",
    "/api/tools/sower-work/download/private", "/api/admin/sower-work/users/extra",
    "/api/managed-users/user_a/sower-work-access/extra", "/api/managed-users/user_a/reset-password",
    "/api/ai-access/execute", "/api/shops", "/api/v1/models"
  ])("does not grant similar-prefix exception %s", path => expect(isProductionSelfAuthenticatedPath(path)).toBe(false));
});
