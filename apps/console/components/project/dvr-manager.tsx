"use client";
import { StreamingHeader, StreamEmptyState } from "./stream-ui";
import { History } from "lucide-react";
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
    <div className="space-y-5">
      <StreamingHeader
        title="Viewer rewind"
        description="Let viewers pause and rewind your live broadcast."
      />
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(16rem,1fr)]">
        <div className="min-w-0 space-y-5">
          <StreamSectionCard
            title="Rewind playback"
            description="Preview the media available for the selected broadcast."
          >
            {playback?.broadcastId && ["live", "ended"].includes(playback.state) ? (
              <StreamPreview
                key={playback.windowId}
                projectId={projectId}
                environmentId={environmentId}
                streamId={streamId}
                dvr
                broadcastId={playback.broadcastId}
              />
            ) : (
              <StreamEmptyState
                title={playback ? "No rewind media available" : "Checking playback"}
                description="Enable rewind before starting a broadcast. Retained media appears here as it arrives."
                icon={History}
              />
            )}
            {!workspace && (
              <Label className="grid gap-2">
                Broadcast ID (leave blank for latest)
                <Input
                  value={broadcastId}
                  onChange={(e) => {
                    setPlayback(null);
                    setBroadcastId(e.target.value);
                  }}
                  placeholder="broadcast_..."
                />
              </Label>
            )}
          </StreamSectionCard>
          <StreamSectionCard
            title="Retained media"
            actions={
              <span role="status" className="text-xs capitalize text-muted-foreground">
                {playback?.state ?? "Loading..."}
              </span>
            }
          >
            <dl className="grid grid-cols-2 gap-4 text-sm">
              {[
                {
                  label: "Available duration",
                  value:
                    playback?.startSeconds != null && playback.endSeconds != null
                      ? `${Math.max(0, playback.endSeconds - playback.startSeconds).toFixed(1)} seconds`
                      : "--",
                },
                {
                  label: "Stored media",
                  value: playback ? `${(playback.storedBytes / 1048576).toFixed(1)} MiB` : "--",
                },
                {
                  label: "Media delivered",
                  value: playback ? `${(playback.deliveredBytes / 1048576).toFixed(1)} MiB` : "--",
                },
                { label: "Rewind", value: enabled ? "Enabled" : "Disabled" },
              ].map(({ label, value }) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            {playback?.expiresAt && (
              <p className="text-xs text-muted-foreground">
                Available until {new Date(playback.expiresAt).toLocaleString()}.
              </p>
            )}
          </StreamSectionCard>
        </div>
        <StreamSectionCard
          title="Rewind settings"
          description="Changes apply to the next broadcast. Existing media stays available until its retention period ends."
        >
          {canManage && (
            <form
              className="grid gap-5"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <Label className="flex items-start gap-2 text-sm leading-relaxed">
                <Switch checked={enabled} onCheckedChange={(e) => setEnabled(e)} />
                Enable DVR
              </Label>
              <Label className="grid gap-2">
                Rewind window (seconds, 30 to 1800)
                <Input
                  type="number"
                  min={30}
                  max={1800}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                />
              </Label>
              <Label className="grid gap-2">
                Storage limit (MiB, 16 to 512)
                <Input
                  type="number"
                  min={16}
                  max={512}
                  value={bytes}
                  onChange={(e) => setBytes(Number(e.target.value))}
                />
              </Label>
              <Label className="grid gap-2">
                Keep playback after stopping (seconds, 0 to 1800)
                <Input
                  type="number"
                  min={0}
                  max={1800}
                  value={retention}
                  onChange={(e) => setRetention(Number(e.target.value))}
                />
              </Label>
              <Label className="flex items-start gap-2 text-sm leading-relaxed">
                <Checkbox checked={consent} onCheckedChange={(e) => setConsent(e)} />I have
                permission to retain this media.
              </Label>
              <Button type="submit" disabled={pending || !policy || !consent}>
                {pending ? "Saving..." : "Save rewind settings"}
              </Button>
            </form>
          )}

          {!canManage && (
            <p className="text-sm text-muted-foreground">
              Project management access is required to change rewind settings.
            </p>
          )}
        </StreamSectionCard>
      </div>
    </div>
  );
}
