// 加载骨架：配合各路由的 loading.tsx，让点击导航后立即出现占位（流式 TTFB），
// 把"后端渲染耗时"从整段白屏降级为局部 loading。纯展示、无数据依赖。
export function PageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="skeleton-page" aria-busy="true" aria-label="加载中">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-sub" />
      <div className="skeleton-cards">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton skeleton-card" />
        ))}
      </div>
      <div className="skeleton-list">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="skeleton skeleton-line" />
        ))}
      </div>
    </div>
  );
}
