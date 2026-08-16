const SHARED_DMP_REPORT_PATH = /^\/shared\/dmp-reports\/[a-f0-9]{64}$/i;

/**
 * 登录后只允许回到固定的站内达摩盘报告路径，避免把 returnTo 变成开放重定向。
 */
export function safeDmpReportReturnPath(value: string | null | undefined) {
  const path = String(value ?? "").trim();
  return SHARED_DMP_REPORT_PATH.test(path) ? path : "";
}
