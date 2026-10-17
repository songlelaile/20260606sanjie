import { safeDmpReportReturnPath } from "./dmp-report-share-path";

const IMAGE_PATH = "/dashboards/operating-network";
const VIDEO_PATH = `${IMAGE_PATH}/video`;
const IMAGE_SURFACES = new Set([
  "main", "detail", "reference", "sku", "viral", "viral-case", "viral-style", "viral-scene", "clothing", "buyer", "refinement"
]);

/** Accept only existing creative module paths and their limited public selectors. */
export function safeCreativeReturnPath(value: string | null | undefined): string {
  const path = String(value ?? "").trim();
  if (!path || /[\u0000-\u0020\u007f\\#]/.test(path)) return "";
  if (path === VIDEO_PATH) return VIDEO_PATH;
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex < 0 ? path : path.slice(0, queryIndex);
  if (pathname !== IMAGE_PATH) return "";

  const params = new URLSearchParams(queryIndex < 0 ? "" : path.slice(queryIndex + 1));
  for (const name of params.keys()) {
    if (name !== "surface" && name !== "batch") return "";
    if (params.getAll(name).length !== 1) return "";
  }
  const surface = params.get("surface");
  const batch = params.get("batch");
  if (surface !== null && !IMAGE_SURFACES.has(surface)) return "";
  if (batch !== null && batch !== "1") return "";

  const canonical = new URLSearchParams();
  if (surface !== null) canonical.set("surface", surface);
  if (batch !== null) canonical.set("batch", batch);
  const query = canonical.toString();
  return IMAGE_PATH + (query ? `?${query}` : "");
}

/** Preserve report sharing rules while supporting a small creative-module allowlist. */
export function safeAuthReturnPath(value: string | null | undefined): string {
  return safeDmpReportReturnPath(value) || safeCreativeReturnPath(value);
}
