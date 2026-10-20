"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { attachBroadcastPlayback, StreamPlaybackClient } from "@relayrtc/client";
import type { BroadcastPlaybackState } from "@relayrtc/client";
import { createAssetGrantAction, getRecordingPlaybackAction } from "@/actions/recordings";
import { Button } from "@/components/ui/button";

export function RecordingPreview({
  projectId,
  environmentId,
  recordingId,
  assetId,
}: {
  projectId: string;
  environmentId: string;
  recordingId: string;
  assetId: string;
}) {
  const media = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<BroadcastPlaybackState>("loading");
  useEffect(() => {
    if (!media.current) return;
    const scope = { projectId, environmentId, recordingId };
    const client = new StreamPlaybackClient({
      mode: "vod",
      getPlayback: async (signal) => {
        const result = await getRecordingPlaybackAction(scope);
        signal.throwIfAborted();
        if (result.error) throw new Error("Playback unavailable");
        return result.data;
      },
      getGrant: async (signal) => {
        const result = await createAssetGrantAction({
          projectId,
          environmentId,
          assetId,
          action: "playback",
          idempotencyKey: crypto.randomUUID(),
        });
        signal.throwIfAborted();
        if (result.error) throw new Error("Grant unavailable");
        return result.data;
      },
    });
    const detach = attachBroadcastPlayback(media.current, client, {
      mode: "vod",
      autoPlay: false,
      onState: setState,
      createHlsEngine: (video, url, onError, onReady) => {
        if (!Hls.isSupported()) throw new Error("Unsupported browser");
        const hls = new Hls({ lowLatencyMode: false });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal || data.response?.code === 401 || data.response?.code === 410) onError();
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
  }, [projectId, environmentId, recordingId, assetId]);
  return (
    <div className="space-y-2">
      <video
        ref={media}
        className="aspect-video w-full rounded-lg bg-black"
        controls
        playsInline
        aria-label="Private recording preview"
      />
      <p role="status" className="text-sm text-muted-foreground">
        {state === "unavailable"
          ? "Recording is being prepared."
          : state === "unsupported"
            ? "This browser cannot play this stream."
            : state === "error"
              ? "Preview unavailable. Check recording status and access."
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
