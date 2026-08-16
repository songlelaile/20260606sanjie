const HEAT_GRID_SIZE = 20;
const MAX_CLICK_EVENTS_PER_REQUEST = 50;

export interface DmpClickEventInput {
  sectionKey?: unknown;
  elementKey?: unknown;
  x?: unknown;
  y?: unknown;
}

export interface DmpNormalizedClickEvent {
  sectionKey: string;
  elementKey: string;
  xBucket: number;
  yBucket: number;
  count: number;
}

function cleanTrackingKey(value: unknown, fallback: string, maxLength: number) {
  const cleaned = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return cleaned || fallback;
}

function normalizedCoordinate(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(1, Math.max(0, numeric));
}

export function normalizeDmpClickEvents(value: unknown): DmpNormalizedClickEvent[] {
  if (!Array.isArray(value)) return [];
  const grouped = new Map<string, DmpNormalizedClickEvent>();
  for (const candidate of value.slice(0, MAX_CLICK_EVENTS_PER_REQUEST)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const event = candidate as DmpClickEventInput;
    const x = normalizedCoordinate(event.x);
    const y = normalizedCoordinate(event.y);
    if (x == null || y == null) continue;
    const sectionKey = cleanTrackingKey(event.sectionKey, "report", 64);
    const elementKey = cleanTrackingKey(event.elementKey, "unknown", 96);
    const xBucket = Math.min(HEAT_GRID_SIZE - 1, Math.floor(x * HEAT_GRID_SIZE));
    const yBucket = Math.min(HEAT_GRID_SIZE - 1, Math.floor(y * HEAT_GRID_SIZE));
    const key = [sectionKey, elementKey, xBucket, yBucket].join("\u001f");
    const existing = grouped.get(key);
    if (existing) existing.count += 1;
    else grouped.set(key, { sectionKey, elementKey, xBucket, yBucket, count: 1 });
  }
  return [...grouped.values()];
}
