export type SowerSurface = "conversation" | "workbench" | "detail";

export const SOWER_SURFACES: { id: SowerSurface; label: string; path: string }[] = [
  { id: "conversation", label: "对话与智能体", path: "/sower-work/app/" },
  { id: "workbench", label: "关键词 · 链接 · 知识", path: "/sower-work/app/cloud-workbench" },
  { id: "detail", label: "长详情编辑与导出", path: "/sower-work/app/cloud-detail" }
];

/** Accept only the currently mounted, same-origin frame with this load's nonce. */
export function isSowerFrameReady(
  event: Pick<MessageEvent, "origin" | "source" | "data">,
  expected: { origin: string; source: MessageEventSource | null; token: string }
): boolean {
  if (!expected.source || !expected.token || event.origin !== expected.origin || event.source !== expected.source) return false;
  const data: unknown = event.data;
  return typeof data === "object" && data !== null &&
    "type" in data && data.type === "SOWER_WORK_RENDERER_READY" &&
    "v" in data && data.v === 1 && "token" in data && data.token === expected.token;
}
