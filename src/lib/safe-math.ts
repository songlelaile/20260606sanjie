/**
 * 全项目统一的除法口径。
 *
 * 电商报表里"分母为 0"几乎总是**没有数据**（新品未上架、断货、当天无投放），
 * 而不是"该指标真的等于 0"。把它算成 0 会让运营把"没数据"读成"表现崩溃"，
 * 是本项目历史上反复出现的一类误导。
 *
 * 因此约定：
 * - 强度类指标（转化率 / 客单价 / ROI / 退款率 / CPC / 访客价值…）一律用
 *   {@link divideOrNull}，分母为 0 时返回 null，由展示层渲染成"—/无数据"。
 * - 只有在"缺失确实等价于 0"的可加和场景（如未投放即花费 0 元），才用
 *   {@link divideOrZero}。
 */

/** 分母为 0 或输入非有限数时返回 null，表示"无法计算"，不得当作 0 展示。 */
export function divideOrNull(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

/** 仅用于"缺失确实等价于 0"的场景；其余一律使用 divideOrNull。 */
export function divideOrZero(numerator: number, denominator: number): number {
  return divideOrNull(numerator, denominator) ?? 0;
}

/**
 * 比率型指标的安全除法：分母为 0 时通常返回 null；
 * 但若分子非 0（例如支付金额为 0 却存在退款），说明数据本身异常，
 * 返回 null 的同时调用方应单独告警，绝不能返回 0 掩盖成"零退款"。
 */
export function isAnomalousRatio(numerator: number, denominator: number): boolean {
  return denominator === 0 && Number.isFinite(numerator) && numerator !== 0;
}
