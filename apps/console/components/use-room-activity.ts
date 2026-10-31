"use client";

import { useEffect, useState } from "react";
import type { RoomActivitySnapshot } from "@relayrtc/types";
import { AccountApiError } from "@/lib/account-api";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useWorkspace } from "./workspace-provider";

export function useRoomActivityResource(base: string) {
  const resource = useWorkspaceResource<RoomActivitySnapshot>(`${base}/activity`);
  const { revision } = useWorkspace();
  const [live, setLive] = useState<{
    base: string;
    revision: number;
    snapshot: RoomActivitySnapshot;
  } | null>(null);
  const [speech, setSpeech] = useState<{
    base: string;
    revision: number;
    observed: ReadonlyMap<string, number>;
  } | null>(null);
  const { refresh } = resource;
  useEffect(() => {
    let stream: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const controller = new AbortController();
    function isStopped() {
      return controller.signal.aborted;
    }
    function connect() {
      clearTimeout(retry);
      if (isStopped()) return;
      if (document.visibilityState !== "visible") {
        stream?.close();
        stream = undefined;
        return;
      }
      if (stream) return;
      const source = new EventSource(`${base}/activity/events`);
      stream = source;
      async function recover() {
        if (isStopped() || stream !== source) return;
        source.close();
        stream = undefined;
        setLive(null);
        failures++;
        let delay = Math.min(30000, 500 * 2 ** Math.min(failures - 1, 6));
        try {
          await refresh(controller.signal);
        } catch (error) {
          if (error instanceof AccountApiError) {
            if ([401, 403, 404].includes(error.status)) return;
            if (error.retryAfter) delay = Math.max(delay, error.retryAfter * 1000);
          }
        }
        if (!isStopped() && document.visibilityState === "visible")
          retry = setTimeout(connect, delay);
      }
      source.addEventListener("snapshot", (event: MessageEvent<string>) => {
        if (isStopped() || stream !== source) return;
        try {
          const snapshot = JSON.parse(event.data) as RoomActivitySnapshot;
          const receivedAt = Date.now();
          setLive({ base, revision, snapshot });
          setSpeech((current) => {
            const previous =
              current?.base === base && current.revision === revision
                ? current.observed
                : new Map<string, number>();
            const members = new Set(
              snapshot.participants.map((participant) => participant.participantId),
            );
            for (const speaker of snapshot.speakers) members.add(speaker.participantId);
            const observed = new Map<string, number>();
            if (snapshot.policy.speakersEnabled) {
              for (const [id, at] of previous) if (members.has(id)) observed.set(id, at);
              if (snapshot.speakerState === "available") {
                for (const speaker of snapshot.speakers)
                  observed.set(speaker.participantId, receivedAt);
              }
            }
            if (
              current?.base === base &&
              current.revision === revision &&
              observed.size === previous.size &&
              [...observed].every(([id, at]) => previous.get(id) === at)
            )
              return current;
            return { base, revision, observed };
          });
          failures = 0;
        } catch {
          void recover();
        }
      });
      source.onerror = () => {
        void recover();
      };
    }
    connect();
    document.addEventListener("visibilitychange", connect);
    return () => {
      clearTimeout(retry);
      stream?.close();
      controller.abort();
      document.removeEventListener("visibilitychange", connect);
    };
  }, [base, refresh, revision]);
  const snapshot = live?.base === base && live.revision === revision ? live.snapshot : null;
  let data =
    snapshot &&
    (!resource.data || Date.parse(snapshot.observedAt) > Date.parse(resource.data.observedAt))
      ? snapshot
      : resource.data;
  if (!snapshot && data)
    data = {
      ...data,
      speakers: [],
      dominantSpeakerId: null,
      speakerState: data.policy.speakersEnabled ? "unavailable" : "disabled",
      participants: data.participants.map((participant) => ({
        ...participant,
        state: participant.state === "hidden" ? "hidden" : "unknown",
      })),
    };
  return {
    ...resource,
    data,
    error: snapshot ? "" : resource.error,
    loading: !snapshot && resource.loading,
    lastSpoke:
      speech?.base === base && speech.revision === revision
        ? speech.observed
        : new Map<string, number>(),
  };
}
