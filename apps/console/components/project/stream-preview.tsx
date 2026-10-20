"use client";
import { Slider } from "@/components/ui/slider";
import { Radio, LoaderCircle } from "lucide-react";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import {
  attachBroadcastPlayback,
  StreamPlaybackClient,
  DvrPlaybackController,
  initialDvrPlaybackState,
} from "@relayrtc/client";
import type { BroadcastPlaybackState } from "@relayrtc/client";
import { createStreamPlaybackGrantAction, getStreamPlaybackAction } from "@/actions/streaming";
import { dvrPlaybackAction, dvrGrantAction } from "@/actions/dvr";
import { Button } from "@/components/ui/button";
import type { StreamPlaybackReadiness } from "@relayrtc/types";

export function StreamPreview({
  projectId,
  environmentId,
  streamId,
  dvr = false,
  broadcastId,
  onReadiness,
}: {
  projectId: string;
  environmentId: string;
  streamId: string;
  dvr?: boolean;
  broadcastId?: string;
  onReadiness?: (readiness: StreamPlaybackReadiness | null) => void;
}) {
  const media = useRef<HTMLVideoElement>(null);
  const controls = useRef<DvrPlaybackController | null>(null);
  const [dvrState, setDvrState] = useState(initialDvrPlaybackState);
  const [state, setState] = useState<BroadcastPlaybackState>("loading");
  const [readiness, setReadiness] = useState<StreamPlaybackReadiness | null>(null);
  const retry = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!media.current) return;
    const scope = { projectId, environmentId, streamId };
    const dvrScope = { ...scope, ...(broadcastId ? { broadcastId } : {}) };
    const client = new StreamPlaybackClient({
      mode: dvr ? "dvr" : "live",
      getPlayback: async (signal) => {
        const result = await (dvr ? dvrPlaybackAction(dvrScope) : getStreamPlaybackAction(scope));
        signal.throwIfAborted();
        if (result.error) {
          setReadiness(null);
          onReadiness?.(null);
          throw new Error("Playback unavailable");
        }
        const next = "readiness" in result.data ? (result.data.readiness ?? null) : null;
        setReadiness(next);
        onReadiness?.(next);
        return result.data;
      },
      getGrant: async (signal) => {
        const result = await (dvr
          ? dvrGrantAction(dvrScope)
          : createStreamPlaybackGrantAction(scope));
        signal.throwIfAborted();
        if (result.error) throw new Error("Grant unavailable");
        return result.data;
      },
    });
    const detach = attachBroadcastPlayback(media.current, client, {
      mode: dvr ? "dvr" : "live",
      onState: setState,
      createHlsEngine: (video, url, onError, onReady) => {
        if (!Hls.isSupported()) throw new Error("Unsupported browser");
        const hls = new Hls({
          lowLatencyMode: !dvr,
          liveSyncDuration: 6,
          liveMaxLatencyDuration: Infinity,
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal || data.response?.code === 401 || data.response?.code === 410) onError();
        });
        hls.on(Hls.Events.MANIFEST_PARSED, onReady);
        hls.attachMedia(video);
        hls.loadSource(url);
        return () => hls.destroy();
      },
    });
    const controller = dvr ? new DvrPlaybackController(media.current) : null;
    retry.current = () => {
      setState("loading");
      void client.refresh(true);
    };
    controls.current = controller;
    const unsubscribe = controller?.subscribe(() => setDvrState(controller.getSnapshot()));
    controller?.start();
    client.start();
    return () => {
      unsubscribe?.();
      controller?.stop();
      controls.current = null;
      detach();
      client.dispose();
      retry.current = null;
    };
  }, [projectId, environmentId, streamId, dvr, broadcastId, onReadiness]);
  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-lg bg-slate-950">
        <video
          ref={media}
          className="aspect-video w-full bg-slate-950"
          controls
          muted
          playsInline
          aria-label="Private stream preview"
        />
        {!["playing", "paused", "blocked"].includes(state) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-10 top-0 flex flex-col items-center justify-center gap-2 bg-linear-to-br from-slate-900/80 to-slate-950 px-5 text-center">
            <span className="mb-1 grid size-10 place-items-center rounded-full border border-white/10 bg-white/5">
              {state === "loading" ? (
                <LoaderCircle className="size-5 animate-spin text-slate-400" />
              ) : (
                <Radio className="size-5 text-slate-400" />
              )}
            </span>
            <p className="text-sm font-medium text-slate-200">
              {state === "loading"
                ? "Connecting to preview"
                : state === "unsupported"
                  ? "Preview unavailable"
                  : state === "error"
                    ? "Reconnecting to preview"
                    : readiness?.status === "failed"
                      ? "Source failed"
                      : readiness?.status === "ended"
                        ? "Broadcast ended"
                        : readiness?.status === "degraded"
                          ? "Preparing playback"
                          : readiness?.status === "reconnecting"
                            ? "Source reconnecting"
                            : "Waiting for your source"}
            </p>
            <p className="max-w-xs text-[11px] leading-relaxed text-slate-400">
              {state === "unsupported"
                ? "Try a browser with HLS playback support."
                : state === "error"
                  ? "Playback will resume when the connection recovers."
                  : readiness?.status === "failed"
                    ? "Check your encoder connection and start the source again."
                    : readiness?.status === "ended"
                      ? "Start a new broadcast to resume live playback."
                      : readiness?.sourceProducing && !readiness.viewerReady
                        ? "The source is sending media. Waiting for playable audio and video."
                        : "Your video will appear here when media is available."}
            </p>
          </div>
        )}
        {state === "playing" && (!dvr || dvrState.isLive) && (
          <span className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1.5 rounded bg-red-500 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white">
            <span className="size-1.5 rounded-full bg-white" />
            Live
          </span>
        )}
      </div>
      {dvr && (
        <div className="space-y-2" aria-label="DVR playback controls">
          <p role="status" aria-live="polite">
            {!dvrState.available
              ? "Waiting for retained media"
              : dvrState.isLive
                ? "Live"
                : `${Math.round(dvrState.behindLiveSeconds)} seconds behind live`}
          </p>
          <label>
            Seek
            <Slider
              aria-label="Seek retained stream"
              className="w-full"
              min={dvrState.start}
              max={Math.max(dvrState.start + 0.1, dvrState.end)}
              value={[Math.max(dvrState.start, Math.min(dvrState.position, dvrState.end))]}
              step={0.1}
              disabled={!dvrState.available}
              onValueChange={(value) =>
                controls.current?.seek(Array.isArray(value) ? (value[0] ?? dvrState.start) : value)
              }
            />
          </label>
          <Button
            type="button"
            disabled={!dvrState.available}
            onClick={() => controls.current?.rewind(30)}
          >
            Rewind 30 seconds
          </Button>{" "}
          <Button
            type="button"
            disabled={!dvrState.available}
            onClick={() => {
              controls.current?.goLive();
              void media.current?.play().catch(() => setState("blocked"));
            }}
          >
            Go live
          </Button>
          {dvrState.recoveredExpiredSeek && (
            <p role="status">That position expired. Playback moved to retained media.</p>
          )}
        </div>
      )}
      <p role="status" className="text-[11px] text-muted-foreground">
        {state === "unavailable"
          ? "Waiting for a live source."
          : state === "unsupported"
            ? "This browser cannot play this stream."
            : state === "error"
              ? "Preview is reconnecting. Retrying automatically…"
              : state === "loading"
                ? "Connecting to preview..."
                : state === "playing"
                  ? dvr && !dvrState.isLive
                    ? "Playing retained media"
                    : "Playing live media"
                  : state === "paused"
                    ? "Preview paused"
                    : "Select play to watch the preview."}
      </p>
      {!dvr && readiness && (
        <p role="status" className="text-[11px] text-muted-foreground">
          {readiness.viewerReady
            ? "Playback media is ready."
            : readiness.sourceProducing
              ? "Source connected; playback is still preparing. Retrying automatically."
              : readiness.status === "failed"
                ? "The source failed. Check the publisher connection."
                : readiness.status === "ended"
                  ? "The source has ended."
                  : "Waiting for the source to produce media."}
        </p>
      )}
      {state === "error" && (
        <Button type="button" variant="outline" onClick={() => retry.current?.()}>
          Retry preview access
        </Button>
      )}
      {state === "blocked" && (
        <Button
          onClick={() => {
            void media.current?.play().catch(() => setState("blocked"));
          }}
        >
          Play preview
        </Button>
      )}
    </div>
  );
}
