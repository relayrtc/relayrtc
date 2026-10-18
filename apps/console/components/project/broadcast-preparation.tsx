"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { bufferPolicyAction } from "@/actions/clips";
import { dvrPolicyAction } from "@/actions/dvr";
import { getRecordingPolicyAction } from "@/actions/recordings";
import { Badge } from "@/components/ui/badge";
import { useStreamWorkspace } from "./stream-workspace";

export function BroadcastPreparation() {
  const workspace = useStreamWorkspace();
  const [policies, setPolicies] = useState<{
    buffer: boolean;
    dvr: boolean;
    recording: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const projectId = workspace?.projectId,
    environmentId = workspace?.environmentId,
    streamId = workspace?.streamId;
  useEffect(() => {
    if (!projectId || !environmentId || !streamId) return;
    let active = true;
    const scope = { projectId, environmentId, streamId };
    void Promise.all([
      bufferPolicyAction(scope),
      dvrPolicyAction(scope),
      getRecordingPolicyAction(scope),
    ])
      .then(([buffer, dvr, recording]) => {
        if (!active) return;
        const failure = buffer.error ?? dvr.error ?? recording.error;
        if (failure) {
          setError(failure.description);
          return;
        }
        setPolicies({
          buffer: !!buffer.data?.policy?.enabled,
          dvr: !!dvr.data?.policy?.enabled,
          recording: recording.data?.policy?.mode === "automatic",
        });
      })
      .catch(() => {
        if (active) setError("Capture settings could not be loaded. Review them before starting.");
      });
    return () => {
      active = false;
    };
  }, [projectId, environmentId, streamId]);
  if (!workspace) return null;
  const live = workspace.stream.sessions.some((s) => s.state === "live");
  return (
    <section
      className="space-y-4 rounded-xl border border-border/70 bg-card/30 p-4 sm:p-5"
      aria-label="Broadcast preparation"
    >
      <div>
        <h2 className="text-sm font-semibold">Before you broadcast</h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Set up recording, clips and rewind before your next broadcast starts.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <span>Source connection</span>
        <Badge variant={live ? "secondary" : "outline"}>
          {live ? "Receiving media" : "Connect your source"}
        </Badge>
      </div>
      {!live && (
        <Link
          className="block text-xs underline underline-offset-4"
          href={`${workspace.href()}#source-setup`}
        >
          Open encoder or room setup
        </Link>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !policies ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking capture settings…
        </p>
      ) : (
        <div className="divide-y text-xs">
          {[
            {
              label: "Live clips",
              enabled: policies.buffer,
              section: "clips",
              detail: "Keep a rolling buffer for highlights.",
            },
            {
              label: "Viewer rewind",
              enabled: policies.dvr,
              section: "dvr",
              detail: "Let viewers rewind during a broadcast.",
            },
            {
              label: "Automatic recording",
              enabled: policies.recording,
              section: "recordings/new",
              detail: "Save broadcasts for playback after they end.",
            },
          ].map((item) => (
            <div key={item.section} className="flex items-center justify-between gap-4 py-3">
              <div>
                <p>
                  {item.label} · {item.enabled ? "Enabled" : "Off"}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {item.detail}
                </p>
              </div>
              <Link href={workspace.href(item.section)} className="shrink-0 underline">
                Configure
              </Link>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        All three are optional. Private live playback works without them.
      </p>
    </section>
  );
}
