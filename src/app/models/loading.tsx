import { PageSkeleton } from "@/components/Skeleton";

// Show the page frame as soon as navigation starts; server data replaces it when ready.
export default function Loading() {
  return <PageSkeleton rows={6} />;
}
