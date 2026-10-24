export function accountTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function sessionDevice(userAgent: string | null): string {
  const ua = userAgent ?? "";
  const os = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile\//i.test(ua)) ? "iPadOS" : /iPhone|iPod/i.test(ua) ? "iOS" : /Android/i.test(ua) ? "Android" : /Windows/i.test(ua) ? "Windows" : /CrOS/i.test(ua) ? "ChromeOS" : /Macintosh|Mac OS X/i.test(ua) ? "macOS" : /Linux|X11/i.test(ua) ? "Linux" : "Unknown device";
  const browser = /OPR\/|Opera|OPiOS\//i.test(ua) ? "Opera" : /Edg(?:e|A|iOS)?\//i.test(ua) ? "Microsoft Edge" : /SamsungBrowser\//i.test(ua) ? "Samsung Internet" : /Vivaldi\//i.test(ua) ? "Vivaldi" : /Firefox\/|FxiOS\//i.test(ua) ? "Firefox" : /Chrome\/|CriOS\//i.test(ua) ? "Chrome" : /Safari\//i.test(ua) ? "Safari" : "Unknown browser";
  return `${browser} · ${os}`;
}

export function humanizeAction(action: string): string {
  return action.replaceAll(/[._-]/g, " ").replace(/^./, letter => letter.toUpperCase());
}
