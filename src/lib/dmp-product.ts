export const DMP_AUTOMATION_TOOL_CODE = "dmp-automation";
export const DMP_AUTOMATION_VERSION = "2.1.8";
export const DMP_AUTOMATION_ACCESS_DAYS = 30;
export const DMP_AUTOMATION_BRAND = "少壮AI自动化";
export const DMP_AUTOMATION_NAME = `达摩盘一体化自动取数｜${DMP_AUTOMATION_BRAND}`;
export const DMP_AUTOMATION_DOWNLOAD_NAME = `达摩盘一体化自动取数-v${DMP_AUTOMATION_VERSION}｜${DMP_AUTOMATION_BRAND}.zip`;
export const DMP_AUTOMATION_PACKAGE_PARTS = [
  "private-assets",
  "dmp",
  `shaozhuang-dmp-unified-automation-v${DMP_AUTOMATION_VERSION}.zip`
] as const;

export function withDmpAutomationBrand(value: unknown, fallback = "达摩盘业务报告") {
  const clean = String(value ?? fallback)
    .trim()
    .replace(/(?:\s*[|｜·]\s*少壮AI自动化)+$/g, "") || fallback;
  return `${clean}｜${DMP_AUTOMATION_BRAND}`;
}
