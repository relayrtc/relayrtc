"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { attachBroadcastPlayback, StreamPlaybackClient } from "@relayrtc/client";
import type { BroadcastPlaybackState } from "@relayrtc/client";
import { createStreamPlaybackGrantAction, getStreamPlaybackAction } from "@/actions/streaming";
import { Button } from "@/components/ui/button";

export function StreamPreview({
  projectId,
  environmentId,
  streamId,
}: {
  projectId: string;
  environmentId: string;
  streamId: string;
}) {
  const media = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<BroadcastPlaybackState>("loading");
  useEffect(() => {
    if (!media.current) return;
    const scope = { projectId, environmentId, streamId };
    const client = new StreamPlaybackClient({
      getPlayback: async (signal) => {
        const result = await getStreamPlaybackAction(scope);
        signal.throwIfAborted();
        if (result.error) throw new Error("Playback unavailable");
        return result.data;
      },
      getGrant: async (signal) => {
        const result = await createStreamPlaybackGrantAction(scope);
        signal.throwIfAborted();
        if (result.error) throw new Error("Grant unavailable");
        return result.data;
      },
    });
    const detach = attachBroadcastPlayback(media.current, client, {
      onState: setState,
      createHlsEngine: (video, url, onError, onReady) => {
        if (!Hls.isSupported()) throw new Error("Unsupported browser");
        const hls = new Hls({ lowLatencyMode: true });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) onError();
        });
        hls.on(Hls.Events.MANIFEST_PARSED, onReady);
        hls.attachMedia(video);
        hls.loadSource(url);
        return () => hls.destroy();
      },
    });
    client.start();
    return () => {
      detach();
      client.dispose();
    };
  }, [projectId, environmentId, streamId]);
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
      <p role="status" className="text-sm text-muted-foreground">
        {state === "unavailable"
          ? "Waiting for a live source."
          : state === "unsupported"
            ? "This browser cannot play this stream."
            : state === "error"
              ? "Preview unavailable. Check source health and playback access."
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
