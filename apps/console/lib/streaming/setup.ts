export function rtmpEncoderFields(url: string, secret: string) {
  const endpoint = new URL(url);
  return {
    server: `${endpoint.protocol}//${endpoint.host}`,
    streamKey: `${endpoint.pathname.slice(1)}?pass=${encodeURIComponent(secret)}`,
  };
}

export function localDateInput(iso: string) {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localDateToIso(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return "";
  const date = new Date(value);
  // Reject dates normalized across an invalid date or a daylight-saving gap.
  if (!Number.isFinite(date.getTime()) || localDateInput(date.toISOString()) !== value) return "";
  return date.toISOString();
}
