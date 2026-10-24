const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatMetric(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "Unavailable" : number.format(value);
}
