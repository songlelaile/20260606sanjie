const WORKFLOW_URL = "/creative/labs/image-prompt-lab/promptlab.html?mode=viral&source=web&layout=1&workflow=1";

export const CREATIVE_VIRAL_SURFACES = [
  { id: "viral-case", label: "案例裂变", route: "case", src: `${WORKFLOW_URL}&creativeRoute=case` },
  { id: "viral-style", label: "风格焕新", route: "style-refresh", src: `${WORKFLOW_URL}&creativeRoute=style-refresh` },
  { id: "viral-scene", label: "场景延展", route: "scene-extension", src: `${WORKFLOW_URL}&creativeRoute=scene-extension` }
] as const;

export function isDedicatedViralSurface(value: string) {
  return CREATIVE_VIRAL_SURFACES.some((item) => item.id === value);
}
