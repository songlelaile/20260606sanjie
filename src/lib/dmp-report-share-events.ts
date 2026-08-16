const HEAT_GRID_SIZE = 20;
const MAX_CLICK_EVENTS_PER_REQUEST = 50;
const MAX_ACTIVE_SECONDS = 6 * 60 * 60;
const TRACKING_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

const ALLOWED_SECTION_KEYS = new Set([
  "report",
  "hero",
  "hero-actions",
  "privacy-note",
  "report-nav",
  "summary",
  "table:报告总览",
  "table:对标总表",
  "table:商品与成功品",
  "table:周期汇总",
  "table:日GMV与费比",
  "table:渠道花费",
  "table:一级场景",
  "table:二级场景",
  "table:成长阶段数据",
  "table:基础指标对比",
  "table:关键词样本",
  "table:流量投放结构",
  "table:渠道指标",
  "table:人群画像"
]);

const ALLOWED_ELEMENT_KEYS = new Set([
  "a",
  "button",
  "div",
  "footer",
  "header",
  "main",
  "nav",
  "p",
  "print",
  "section",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "copy-link"
]);

const INDEXED_ELEMENT_PATTERN = /^(?:nav|table-scroll):(?:[1-9]|1\d|20)$|^(?:header|cell):(?:0|[1-9]\d?)$/;

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

export interface DmpPublicEventAttribution {
  source: string;
  medium: string;
  campaign: string;
  referrerHost: string;
}

interface DmpPublicEventBase extends DmpPublicEventAttribution {
  eventId: string;
  visitorId: string;
  sessionId: string;
}

export type DmpNormalizedPublicShareEvent =
  | (DmpPublicEventBase & { type: "view" })
  | (DmpPublicEventBase & { type: "click"; events: DmpNormalizedClickEvent[] })
  | (DmpPublicEventBase & {
      type: "engagement";
      activeSeconds: number;
      maxScrollDepth: number;
    });

function cleanKey(value: unknown, maxLength: number) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizedCoordinate(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(1, Math.max(0, numeric));
}

function normalizeTrackingId(value: unknown) {
  const id = String(value ?? "").trim();
  return TRACKING_ID_PATTERN.test(id) ? id : null;
}

function normalizeAttributionValue(value: unknown, maxLength: number) {
  return cleanKey(value, maxLength)
    .replace(/[^\p{L}\p{N}._+/@ -]/gu, "")
    .slice(0, maxLength);
}

function normalizeReferrerHost(value: unknown) {
  const raw = String(value ?? "").trim().slice(0, 2_048);
  if (!raw) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return "";
    return host;
  } catch {
    return "";
  }
}

function normalizeAttribution(value: Record<string, unknown>): DmpPublicEventAttribution {
  return {
    source: normalizeAttributionValue(value.utmSource ?? value.source, 64),
    medium: normalizeAttributionValue(value.utmMedium ?? value.medium, 64),
    campaign: normalizeAttributionValue(value.utmCampaign ?? value.campaign, 96),
    referrerHost: normalizeReferrerHost(value.sourceDomain ?? value.referrerHost)
  };
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
    const sectionKey = cleanKey(event.sectionKey, 64);
    const elementKey = cleanKey(event.elementKey, 96);
    if (!ALLOWED_SECTION_KEYS.has(sectionKey)) continue;
    if (!ALLOWED_ELEMENT_KEYS.has(elementKey) && !INDEXED_ELEMENT_PATTERN.test(elementKey)) continue;
    const xBucket = Math.min(HEAT_GRID_SIZE - 1, Math.floor(x * HEAT_GRID_SIZE));
    const yBucket = Math.min(HEAT_GRID_SIZE - 1, Math.floor(y * HEAT_GRID_SIZE));
    const key = [sectionKey, elementKey, xBucket, yBucket].join("\u001f");
    const existing = grouped.get(key);
    if (existing) existing.count += 1;
    else grouped.set(key, { sectionKey, elementKey, xBucket, yBucket, count: 1 });
  }
  return [...grouped.values()];
}

export function normalizeDmpPublicShareEvent(value: unknown): DmpNormalizedPublicShareEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const eventId = normalizeTrackingId(input.eventId);
  const visitorId = normalizeTrackingId(input.visitorId);
  const sessionId = normalizeTrackingId(input.sessionId);
  if (!eventId || !visitorId || !sessionId) return null;
  const common = { eventId, visitorId, sessionId, ...normalizeAttribution(input) };

  if (input.type === "view") return { type: "view", ...common };
  if (input.type === "click") {
    const events = normalizeDmpClickEvents(input.events);
    return { type: "click", ...common, events };
  }
  if (input.type === "engagement") {
    const rawActiveSeconds = Number(input.activeSeconds);
    const rawScrollDepth = Number(input.maxScrollDepth);
    if (!Number.isFinite(rawActiveSeconds) || !Number.isFinite(rawScrollDepth)) return null;
    return {
      type: "engagement",
      ...common,
      activeSeconds: Math.min(MAX_ACTIVE_SECONDS, Math.max(0, Math.round(rawActiveSeconds))),
      maxScrollDepth: Math.min(100, Math.max(0, Math.round(rawScrollDepth)))
    };
  }
  return null;
}
