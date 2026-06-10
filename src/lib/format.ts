export function formatNumber(value: number, digits = 0) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(value);
}

export function formatMoney(value: number, digits = 0) {
  if (!Number.isFinite(value)) {
    return "¥—";
  }
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(value);
}

export function formatPercent(value: number, digits = 1) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return new Intl.NumberFormat("zh-CN", {
    style: "percent",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(value);
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
