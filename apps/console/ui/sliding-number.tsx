"use client";

import type { ReactNode } from "react";
import { SlidingNumber as SlidingNumberPrimitive } from "@animate-ui/react/primitives/texts/sliding-number";
import { Skeleton } from "./skeleton";

// Use the requested Animate UI primitive, with the dashboard's own typography.
export function SlidingNumber({ value, decimalPlaces = 0, separator = true }: { value: number; decimalPlaces?: number; separator?: boolean }) {
  if (!Number.isFinite(value)) return <span>Unavailable</span>;
  return <SlidingNumberPrimitive className="sliding-number" number={value} decimalPlaces={decimalPlaces} thousandSeparator={separator ? "," : undefined} initiallyStable transition={{ stiffness: 200, damping: 20, mass: 0.4 }} />;
}

const units = new Set(["b", "kb", "mb", "gb", "tb", "kib", "mib", "gib", "tib", "bps", "kbps", "mbps", "gbps", "ms", "s", "m", "h", "d", "min", "mins", "sec", "secs", "seconds", "minutes", "hours", "days", "fps", "of", "connected", "sessions", "participants", "samples", "attempts", "replays", "members", "invitations", "resources", "bytes", "messages", "on", "this", "page"]);

export function AnimatedValue({ value }: { value: ReactNode }) {
  if (typeof value === "string" && /^Loading\b/.test(value)) return <Skeleton className="skeleton-inline" style={{ width: 63 }} />;
  if (typeof value === "number") return <SlidingNumber value={value} decimalPlaces={Number.isInteger(value) ? 0 : Math.min(2, String(value).split(".")[1]?.length ?? 0)} />;
  if (typeof value !== "string" || !/\d/.test(value)) return <>{value}</>;
  // Keep identifiers, addresses, timestamps, and arbitrary user text untouched.
  if (/@|https?:|[a-z0-9]_[a-z0-9]|^\d{4}-\d{2}-\d{2}|^\d{1,3}(?:\.\d{1,3}){3}$/i.test(value) || /^\d{15,}$/.test(value)) return <>{value}</>;
  if ((value.match(/[a-z]+/gi) ?? []).some(word => !units.has(word.toLowerCase()))) return <>{value}</>;
  const parts = value.split(/(\d[\d,]*(?:\.\d+)?)/g);
  return <span className="animated-value">{parts.map((part, index) => {
    if (!/^\d[\d,]*(?:\.\d+)?$/.test(part)) return <span key={index}>{part}</span>;
    const numeric = Number(part.replaceAll(",", ""));
    if (!Number.isFinite(numeric) || numeric > Number.MAX_SAFE_INTEGER) return <span key={index}>{part}</span>;
    const decimals = Math.min(6, part.split(".")[1]?.length ?? 0);
    const integer = part.split(".")[0].replaceAll(",", "");
    const zeros = integer.match(/^0+(?=\d)/)?.[0] ?? "";
    return <span className="animated-token" key={index}>{zeros}<SlidingNumber value={numeric} decimalPlaces={decimals} separator={part.includes(",")} /></span>;
  })}</span>;
}
