import { PageSkeleton } from "@/components/Skeleton";

// 覆盖 /dashboards/* 三个看板：导航即出骨架，服务端渲染完再替换为真实内容。
export default function Loading() {
  return <PageSkeleton rows={8} />;
}
