export function decimalToPercentInput(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return trimTrailingZeros(value * 100);
}

export function percentInputToDecimal(value: string) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric / 100 : 0;
}

function trimTrailingZeros(value: number) {
  return Number(value.toFixed(4)).toString();
}
