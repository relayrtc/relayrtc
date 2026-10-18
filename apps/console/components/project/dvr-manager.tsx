"use client";
import { StreamSectionCard } from "./stream-section-card";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { useStreamWorkspace } from "./stream-workspace";
import { useEffect, useRef, useState } from "react";
import type { DvrPlayback, DvrPolicyResource } from "@relayrtc/types";
import { dvrPlaybackAction, dvrPolicyAction } from "@/actions/dvr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StreamPreview } from "./stream-preview";
export function DvrManager({
  projectId,
  environmentId,
  streamId,
  canManage,
}: {
  projectId: string;
  environmentId: string;
  streamId: string;
  canManage: boolean;
}) {
  const workspace = useStreamWorkspace();
  const [policy, setPolicy] = useState<DvrPolicyResource | null>(null),
    [playback, setPlayback] = useState<DvrPlayback | null>(null);
  const [duration, setDuration] = useState(300),
    [bytes, setBytes] = useState(128),
    [retention, setRetention] = useState(300),
    [enabled, setEnabled] = useState(false),
    [consent, setConsent] = useState(false);
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [broadcastId, setBroadcastId] = useState(workspace?.broadcastId ?? "");
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    void dvrPolicyAction({ projectId, environmentId, streamId })
      .then((result) => {
        if (!active) return;
        if (result.error) {
          setError(result.error.description);
          return;
        }
        setPolicy(result.data);
        const p = result.data.policy;
        if (p) {
          setDuration(p.durationSeconds);
          setBytes(p.maxBytes / 1048576);
          setRetention(p.endedRetentionSeconds);
          setEnabled(p.enabled);
          setConsent(p.consentAcknowledged);
        }
      })
      .catch(() => {
        if (active) setError("DVR policy is unavailable. Try reloading.");
      });
    return () => {
      active = false;
    };
  }, [projectId, environmentId, streamId]);
  useEffect(() => {
    let active = true,
      busy = false;
    const generation = ++revision.current;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await dvrPlaybackAction({
          projectId,
          environmentId,
          streamId,
          ...(broadcastId ? { broadcastId } : {}),
        });
        if (!active || generation !== revision.current) return;
        if (result.error) setError(result.error.description);
        else setPlayback(result.data);
      } catch {
        if (active && generation === revision.current)
          setError("DVR playback is unavailable. Retrying automatically.");
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId, environmentId, streamId, broadcastId]);
  const save = async () => {
    setPending(true);
    setError("");
    try {
      const result = await dvrPolicyAction({
        projectId,
        environmentId,
        streamId,
        idempotencyKey: crypto.randomUUID(),
        configuration: {
          ...(policy?.version ? { version: policy.version } : {}),
          policy: {
            enabled,
            durationSeconds: duration,
            maxBytes: Math.round(bytes * 1048576),
            endedRetentionSeconds: retention,
            consentAcknowledged: consent,
          },
        },
      });
      if (result.error) {
        setError(result.error.description);
        if (result.error.code === "DVR_VERSION_CONFLICT") {
          const fresh = await dvrPolicyAction({ projectId, environmentId, streamId });
          if (fresh.data) setPolicy(fresh.data);
        }
      } else setPolicy(result.data);
    } catch {
      setError("DVR configuration failed. Reload the policy before retrying.");
    } finally {
      setPending(false);
    }
  };
  return (
    <StreamSectionCard
      title="Live DVR"
      description={
        <>
          Rewind retained broadcast media. Changes apply to the next run; disabling drains this run
          for its saved retention period.
        </>
      }
    >
      {!workspace && (
        <>
          <Label className="grid gap-2">
            Broadcast run (blank selects latest)
            <Input
              value={broadcastId}
              onChange={(e) => {
                setPlayback(null);
                setBroadcastId(e.target.value);
              }}
              placeholder="broadcast_..."
            />
          </Label>
        </>
      )}
      <p role="status">
        {playback?.state ?? "Loading"}
        {playback?.windowId ? ` · ${playback.windowId}` : ""}
      </p>
      {playback && (
        <p className="text-sm">
          Available: {playback.startSeconds?.toFixed(1) ?? "—"}–
          {playback.endSeconds?.toFixed(1) ?? "—"} seconds. Shared storage:{" "}
          {(playback.storedBytes / 1048576).toFixed(1)} MiB. Storage byte-seconds:{" "}
          {Math.round(playback.storageByteSeconds)}. Origin delivery:{" "}
          {(playback.deliveredBytes / 1048576).toFixed(1)} MiB. Policy version:{" "}
          {playback.policyVersion ?? "—"}.
        </p>
      )}
      {playback?.wallStart && (
        <p className="text-sm">
          {playback.wallStart} to {playback.wallEnd}
          {playback.expiresAt ? ` · Expires ${playback.expiresAt}` : ""}
        </p>
      )}
      {canManage && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Label className="flex gap-2">
            <Switch checked={enabled} onCheckedChange={(e) => setEnabled(e)} />
            Enable DVR
          </Label>
          <Label className="grid gap-2">
            Window seconds (30–1800)
            <Input
              type="number"
              min={30}
              max={1800}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </Label>
          <Label className="grid gap-2">
            Shared byte cap (MiB, 16–512)
            <Input
              type="number"
              min={16}
              max={512}
              value={bytes}
              onChange={(e) => setBytes(Number(e.target.value))}
            />
          </Label>
          <Label className="grid gap-2">
            Access after stopping/disabling (seconds, 0–1800)
            <Input
              type="number"
              min={0}
              max={1800}
              value={retention}
              onChange={(e) => setRetention(Number(e.target.value))}
            />
          </Label>
          <Label className="flex gap-2">
            <Checkbox checked={consent} onCheckedChange={(e) => setConsent(e)} />I have permission
            to retain this media.
          </Label>
          <Button type="submit" disabled={pending || !policy || !consent}>
            Save DVR policy
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {playback?.broadcastId && ["live", "ended"].includes(playback.state) && (
        <StreamPreview
          key={playback.windowId}
          projectId={projectId}
          environmentId={environmentId}
          streamId={streamId}
          dvr
          broadcastId={playback.broadcastId}
        />
      )}
    </StreamSectionCard>
  );
}
