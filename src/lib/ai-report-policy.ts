/** 深度诊断会生成较长文本，不能沿用 API 连通性测试的短请求时限。 */
export const AI_REPORT_TIMEOUT_MS = 180_000;

/** 报告正文远小于此上限；保留余量，同时阻止异常上游返回超大响应。 */
export const AI_REPORT_MAX_RESPONSE_BYTES = 512 * 1024;

export const AI_REPORT_TIMEOUT_MESSAGE =
  "AI 模型在 3 分钟内未完成深度方案。连接测试只验证短响应，请重试或切换响应更快的模型";
