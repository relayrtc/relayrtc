"use client";

import { useEffect, useState } from "react";
import type { Broadcast, Stream } from "@/lib/stream-types";
import { StreamMixer } from "./stream-mixer";
import { StreamGuestStage } from "./stream-guest-stage";

export function BroadcastStudio({ stream, broadcast, onBusy, onActiveChange, disabled = false }: { stream: Stream; broadcast: Broadcast; onBusy: (busy: boolean) => void; onActiveChange: (active: boolean) => void; disabled?: boolean }) {
  const [view, setView] = useState<"mixer" | "guests" | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { onActiveChange(Boolean(view)); }, [view, onActiveChange]);
  function changing(value: boolean) { setBusy(value); onBusy(value); }
  return <fieldset className="stream-studio" disabled={busy || disabled}><div className="segmented-control stream-studio-tabs" role="group" aria-label="Broadcast studio"><button type="button" disabled={busy} className={view === "mixer" ? "segment-active" : ""} aria-pressed={view === "mixer"} onClick={() => setView(view === "mixer" ? null : "mixer")}>Mixer & scenes</button><button type="button" disabled={busy} className={view === "guests" ? "segment-active" : ""} aria-pressed={view === "guests"} onClick={() => setView(view === "guests" ? null : "guests")}>Guest stage</button></div>{view === "mixer" && <StreamMixer stream={stream} broadcast={broadcast} onBusy={changing} />}{view === "guests" && <StreamGuestStage stream={stream} broadcast={broadcast} onBusy={changing} />}</fieldset>;
}
