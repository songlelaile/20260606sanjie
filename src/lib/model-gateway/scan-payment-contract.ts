/** Display state only. Awaiting allocation never grants paid-plan access. */
export type GatewayOrderAllocationState = { status: string; creditAllocationState?: string };
export const AWAITING_CREDIT_ALLOCATION_LABEL = "已收款，积分待分配";

export function isGatewayOrderAwaitingCapacity(order: GatewayOrderAllocationState | null | undefined) {
  return order?.creditAllocationState === "awaiting_capacity" || order?.status === "awaiting_capacity";
}

export function gatewayOrderDisplayStatus(order: GatewayOrderAllocationState) {
  return isGatewayOrderAwaitingCapacity(order) ? "awaiting_capacity" : order.status;
}
