"use client";

import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import type { MediaGrant } from "@/lib/stream-types";
import { FormFeedback } from "./auth-fields";

export function MediaPlayback({ grant }: { grant: MediaGrant }) {
  const video = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("Loading media…"), [error, setError] = useState("");
  useEffect(() => {
    const media = video.current;
    if (!media) return;
    let hls: Hls | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setError(""); setStatus("Loading media…");
    const reset = () => { hls?.destroy(); hls = null; media.pause(); media.removeAttribute("src"); media.load(); };
    try {
      const url = new URL(grant.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
      const remaining = Date.parse(grant.expiresAt) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) throw new Error();
      const ready = () => setStatus("Ready to play");
      if (media.canPlayType("application/vnd.apple.mpegurl")) {
        media.src = url.href;
      } else if (Hls.isSupported()) {
        hls = new Hls({ lowLatencyMode: true, maxBufferLength: 30 });
        hls.on(Hls.Events.MANIFEST_PARSED, ready);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal || data.response?.code === 401 || data.response?.code === 410) {
            setError("Playback is unavailable or its access link was revoked. Generate a new link and try again."); setStatus(""); reset();
          }
        });
        hls.attachMedia(media); hls.loadSource(url.href);
      } else {
        setError("This browser cannot play HLS. Open the access URL in a compatible player."); setStatus("");
      }
      timer = setTimeout(() => { reset(); setStatus("Access link expired. Generate a new link to continue."); }, remaining);
    } catch { setError("This playback link is invalid or has expired."); setStatus(""); }
    return () => { if (timer) clearTimeout(timer); reset(); };
  }, [grant.url, grant.expiresAt]);
  return <div className="developer-dialog-stack"><video className="media-player" ref={video} controls playsInline crossOrigin="anonymous" preload="metadata" aria-label="Private media preview" onCanPlay={() => setStatus("Ready to play")} onPlaying={() => setStatus("Playing")} onPause={() => setStatus("Paused")} onError={() => { setError("Unable to play this media. Check its availability and generate a new access link."); setStatus(""); }} /><FormFeedback error={error} />{status && <p className="account-note" role="status">{status}</p>}<p className="account-note">Playback contributes to media delivery usage.</p></div>;
}
