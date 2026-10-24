import type { Metadata, Viewport } from "next";
import { NotificationProvider } from "@/components/notification-provider";
import "./globals.css";

export const metadata: Metadata = { title: { default: "Relayrtc Console", template: "%s · Relayrtc" }, description: "Your Relayrtc account dashboard.", referrer: "no-referrer", robots: { index: false, follow: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#ffffff" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a className="skip-link" href="#main-content">Skip to content</a><NotificationProvider>{children}</NotificationProvider></body></html>;
}
