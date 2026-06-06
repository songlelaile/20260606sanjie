import clsx from "clsx";

export function StatusPill({
  children,
  tone = "neutral"
}: {
  children: React.ReactNode;
  tone?: "good" | "warn" | "bad" | "neutral";
}) {
  return <span className={clsx("status-pill", tone)}>{children}</span>;
}
