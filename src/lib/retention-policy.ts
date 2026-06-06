import type { ImportBatch, VersionSnapshot } from "@/lib/types/domain";

const megabyte = 1024 * 1024;

export const retentionPolicy = {
  tenantMaxDatasetBytes: 1000 * megabyte,
  tenantMaxDatasetMegabytes: 1000,
  tenantSavedDatasetLimit: 1,
  adminMaxRollbackShops: 30,
  adminMaxVersionsPerShop: 12
};

export function formatStorageSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0MB";
  }

  const megabytes = bytes / megabyte;
  if (megabytes < 1024) {
    return `${trimNumber(megabytes)}MB`;
  }
  return `${trimNumber(megabytes / 1024)}GB`;
}

export function validateTenantDatasetSize(totalBytes: number) {
  if (!Number.isFinite(totalBytes) || totalBytes < 0) {
    return "本次数据大小无法识别，请重新选择源表。";
  }

  if (totalBytes > retentionPolicy.tenantMaxDatasetBytes) {
    return `本次数据 ${formatStorageSize(totalBytes)}，超过租户端单次保存上限 ${retentionPolicy.tenantMaxDatasetMegabytes}MB，请拆分或清理后重新上传。`;
  }

  return null;
}

export function getImportBatchesSize(batches: ImportBatch[]) {
  return batches.reduce((total, batch) => total + (batch.fileSizeBytes ?? 0), 0);
}

export function pruneAdminVersionSnapshots(versions: VersionSnapshot[]) {
  const byShop = new Map<string, VersionSnapshot[]>();
  for (const version of versions) {
    const shopVersions = byShop.get(version.shopId) ?? [];
    shopVersions.push(version);
    byShop.set(version.shopId, shopVersions);
  }

  const retainedShopIds = [...byShop.entries()]
    .map(([shopId, shopVersions]) => ({
      shopId,
      latestCreatedAt: shopVersions
        .map((version) => version.createdAt)
        .sort()
        .at(-1)!
    }))
    .sort((left, right) => right.latestCreatedAt.localeCompare(left.latestCreatedAt))
    .slice(0, retentionPolicy.adminMaxRollbackShops)
    .map((item) => item.shopId);

  return retainedShopIds
    .flatMap((shopId) =>
      (byShop.get(shopId) ?? [])
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, retentionPolicy.adminMaxVersionsPerShop)
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function trimNumber(value: number) {
  return Number(value.toFixed(value >= 10 ? 1 : 2)).toString();
}
