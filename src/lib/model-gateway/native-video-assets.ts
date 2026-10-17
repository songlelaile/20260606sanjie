import "server-only";
import { nativeAssetContext } from "@/lib/video-assets-server";
import { NativeVideoError, plain, type NativeVideoOwner } from "./native-video-contract";
import type { NativeVideoSupply } from "./native-video-supply";

/** Browser references are local owner-scoped IDs, never supplier IDs. */
export async function nativeVideoAssets(owner: NativeVideoOwner, supply: NativeVideoSupply, body: Record<string, unknown>, taskId?: string) {
  const ids: string[] = [];
  if (Array.isArray(body.content)) for (const item of body.content) {
    if (!plain(item) || !plain(item.image_url) || typeof item.image_url.url !== "string") continue;
    const url = item.image_url.url;
    if (url.startsWith("asset:")) throw new NativeVideoError("NATIVE_VIDEO_ASSET_UNSUPPORTED", "请使用当前账号的报备素材编号");
    if (!url.startsWith("library:")) continue;
    const match = /^library:\/\/(va_[A-Za-z0-9_-]{1,180})$/.exec(url);
    if (item.type !== "image_url" || !match) throw new NativeVideoError("NATIVE_VIDEO_ASSET_UNSUPPORTED", "报备素材引用格式无效");
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  if (!ids.length) return { body, trustedUris: new Set<string>() };
  try {
    const { scope, service } = await nativeAssetContext(owner, supply);
    const references = taskId ? (await service.acquireLease(scope, { taskId, assetIds: ids })).references : await service.resolveReferences(scope, ids);
    const map = new Map(references.map(ref => [ref.id, ref.url]));
    if (map.size !== ids.length || ids.some(id => !/^asset:\/\/asset-[A-Za-z0-9-]+$/.test(map.get(id) || ""))) throw new Error();
    const content = (body.content as Array<Record<string, unknown>>).map(item => {
      if (item.type !== "image_url" || !plain(item.image_url) || typeof item.image_url.url !== "string" || !item.image_url.url.startsWith("library://")) return item;
      return { ...item, image_url: { url: map.get(item.image_url.url.slice(10)) } };
    });
    return { body: { ...body, content }, trustedUris: new Set(references.map(ref => ref.url)) };
  } catch {
    throw new NativeVideoError("NATIVE_VIDEO_ASSET_UNSUPPORTED", "报备素材尚未通过审核，或与当前账号及供应商项目不匹配；视频未提交");
  }
}

/** Unknown/in-flight jobs retain their lease. Local cancellation is not proof. */
export async function releaseNativeVideoAssets(owner: NativeVideoOwner, supply: NativeVideoSupply, taskId: string, status: "succeeded" | "failed") {
  try { const { scope, service } = await nativeAssetContext(owner, supply); await service.releaseLease(scope, { taskId, terminalStatus: status }); }
  catch { /* Retain protection if cleanup cannot be proved; no billing changes. */ }
}
