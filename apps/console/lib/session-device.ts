export function sessionDevice(userAgent: string | null) {
  const ua = userAgent ?? "";
  const os =
    /iPad/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile\//i.test(ua))
      ? "iPadOS"
      : /iPhone|iPod/i.test(ua)
        ? "iOS"
        : /Android/i.test(ua)
          ? "Android"
          : /Windows/i.test(ua)
            ? "Windows"
            : /CrOS/i.test(ua)
              ? "ChromeOS"
              : /Macintosh|Mac OS X/i.test(ua)
                ? "macOS"
                : /Linux|X11/i.test(ua)
                  ? "Linux"
                  : "Unknown device";
  // Chromium browsers include Chrome/Safari tokens; detect their own tokens first.
  const browser = /OPR\/|Opera|OPiOS\//i.test(ua)
    ? "Opera"
    : /Edg(?:e|A|iOS)?\//i.test(ua)
      ? "Microsoft Edge"
      : /SamsungBrowser\//i.test(ua)
        ? "Samsung Internet"
        : /Vivaldi\//i.test(ua)
          ? "Vivaldi"
          : /Firefox\/|FxiOS\//i.test(ua)
            ? "Mozilla Firefox"
            : /Chrome\/|CriOS\//i.test(ua)
              ? "Google Chrome"
              : /Safari\//i.test(ua)
                ? "Safari"
                : "Unknown browser";
  const kind =
    os === "iPadOS" || (/Android/i.test(ua) && !/Mobile/i.test(ua))
      ? "tablet"
      : /iPhone|iPod|Android|Mobile/i.test(ua)
        ? "phone"
        : "desktop";
  return { os, browser, kind, label: `${os} on ${browser}` };
}
