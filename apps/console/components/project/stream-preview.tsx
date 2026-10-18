"use client";
import { Slider } from "@/components/ui/slider";

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

export function StreamPreview({
  projectId,
  environmentId,
  streamId,
  dvr = false,
  broadcastId,
}: {
  projectId: string;
  environmentId: string;
  streamId: string;
  dvr?: boolean;
  broadcastId?: string;
}) {
  const media = useRef<HTMLVideoElement>(null);
  const controls = useRef<DvrPlaybackController | null>(null);
  const [dvrState, setDvrState] = useState(initialDvrPlaybackState);
  const [state, setState] = useState<BroadcastPlaybackState>("loading");
  useEffect(() => {
    if (!media.current) return;
    const scope = { projectId, environmentId, streamId };
    const dvrScope = { ...scope, ...(broadcastId ? { broadcastId } : {}) };
    const client = new StreamPlaybackClient({
      mode: dvr ? "dvr" : "live",
      getPlayback: async (signal) => {
        const result = await (dvr ? dvrPlaybackAction(dvrScope) : getStreamPlaybackAction(scope));
        signal.throwIfAborted();
        if (result.error) throw new Error("Playback unavailable");
        return result.data;
      },
      getGrant: async (signal) => {
        const result = await (dvr && broadcastId
          ? dvrGrantAction({ ...scope, broadcastId })
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
          if (data.fatal) onError();
        });
        hls.on(Hls.Events.MANIFEST_PARSED, onReady);
        hls.attachMedia(video);
        hls.loadSource(url);
        return () => hls.destroy();
      },
    });
    const controller = dvr ? new DvrPlaybackController(media.current) : null;
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
    };
  }, [projectId, environmentId, streamId, dvr, broadcastId]);
  return (
    <div className="space-y-2">
      <video
        ref={media}
        className="aspect-video w-full rounded-lg bg-black"
        controls
        muted
        playsInline
        aria-label="Private stream preview"
      />
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
      <p role="status" className="text-sm text-muted-foreground">
        {state === "unavailable"
          ? "Waiting for a live source."
          : state === "unsupported"
            ? "This browser cannot play this stream."
            : state === "error"
              ? "Preview is reconnecting. Retrying automatically…"
              : state}
      </p>
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
