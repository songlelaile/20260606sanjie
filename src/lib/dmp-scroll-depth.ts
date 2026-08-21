export function calculateDmpScrollDepth({
  scrollTop,
  clientHeight,
  scrollHeight
}: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}) {
  const height = Number.isFinite(scrollHeight) ? Math.max(0, scrollHeight) : 0;
  if (height <= 0) return 0;
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const viewport = Number.isFinite(clientHeight) ? Math.max(0, clientHeight) : 0;
  return Math.max(0, Math.min(100, Math.round((top + viewport) / height * 100)));
}
