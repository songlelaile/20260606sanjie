import type { ReactNode } from "react";

export function KpiGrid({
  items
}: {
  items: Array<{ label: string; value: ReactNode; helper?: ReactNode; tone?: "good" | "warn" | "bad" }>;
}) {
  return (
    <section className="kpi-grid" aria-label="关键指标">
      {items.map((item) => (
        <div className={`kpi ${item.tone ?? ""}`} key={item.label}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          {item.helper ? <small>{item.helper}</small> : null}
        </div>
      ))}
    </section>
  );
}
