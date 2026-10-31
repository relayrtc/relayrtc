"use client";

import { useState } from "react";
import type { RoomActivityPolicy } from "@relayrtc/types";
import { accountRequest } from "@/lib/account-api";
import { humanizeAction } from "@/lib/account-display";
import { roomApiPath } from "@/lib/room-api";
import { formatDuration } from "@/lib/rooms";
import type { RoomSessions } from "@/lib/room-types";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { PanelMessage } from "@/ui/panel-message";
import { EmptyState } from "@/ui/empty-state";
import { AnimatedValue } from "@/ui/sliding-number";
import { ReportSection } from "@/ui/report-controls";
import { RoomConnectionTime } from "@/ui/room-connection-time";
import { SettingsRow } from "@/ui/settings-row";
import { StatusPill } from "@/ui/status-pill";
import { Switch } from "@/ui/switch";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useRoomActivityResource } from "./use-room-activity";
import { useConnectionClock, useRealtimeRefresh } from "./use-realtime-refresh";
import { useDeveloperMutation } from "./use-developer-mutation";
import { useNotifications } from "./notification-provider";

type View = { kind: "activity" } | { kind: "policy"; policy: RoomActivityPolicy };

export function RoomActivityPanel({
  projectId,
  roomId,
  canOperate,
}: {
  projectId: string;
  roomId: string;
  canOperate: boolean;
}) {
  const base = roomApiPath(projectId, roomId);
  const resource = useRoomActivityResource(base);
  const sessions = useWorkspaceResource<RoomSessions>(
    `${base}/sessions?limit=100&offset=0&status=all`,
  );
  useRealtimeRefresh(sessions.refresh, true, 30000);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const data = resource.data;
  const now = useConnectionClock();
  const speaking = new Set(data?.speakers.map((speaker) => speaker.participantId));
  const names = new Map(
    sessions.data?.sessions.map((session) => [session.participantId, session.name]),
  );
  function name(id: string) {
    return names.get(id) ?? `${id.slice(0, 16)}…`;
  }
  return (
    <>
      <ReportSection title="Speakers and activity">
        {data ? (
          <>
            <SettingsRow
              icon="quality"
              label="Speaker observation"
              value={humanizeAction(data.speakerState)}
              onClick={() => {
                setView({ kind: "activity" });
              }}
            />
            <SettingsRow
              icon="users"
              label="Dominant speaker"
              value={data.dominantSpeakerId ? name(data.dominantSpeakerId) : "No current speaker"}
              onClick={() => {
                setView({ kind: "activity" });
              }}
            />
            <SettingsRow
              icon="eye"
              label="Participant activity"
              value={`${String(data.participants.length)} observed`}
              onClick={() => {
                setView({ kind: "activity" });
              }}
            />
            <SettingsRow
              icon="shield"
              label="Activity policy"
              value={
                data.policy.activityEnabled || data.policy.speakersEnabled ? "Enabled" : "Disabled"
              }
              onClick={
                canOperate
                  ? () => {
                      setView({ kind: "policy", policy: data.policy });
                    }
                  : undefined
              }
              trailing={canOperate ? undefined : <></>}
            />
          </>
        ) : (
          <PanelMessage className="account-panel-message" role="status">
            {resource.error ? "Activity unavailable." : "Loading activity…"}
          </PanelMessage>
        )}
      </ReportSection>
      <FormFeedback error={resource.error} />
      {resource.error && (
        <Button
          className="workspace-section-button"
          onClick={() => {
            void resource.refresh().catch(() => undefined);
          }}
        >
          Try again
        </Button>
      )}
      <Dialog
        open={view !== null && !!data}
        title={view?.kind === "policy" ? "Activity policy" : "Live room activity"}
        dismissible={!busy}
        onClose={() => {
          setView(null);
        }}
      >
        {view?.kind === "policy" && (
          <ActivityPolicyForm
            key={view.policy.version}
            base={base}
            policy={view.policy}
            canOperate={canOperate}
            onBusy={setBusy}
            onReload={() => {
              void resource
                .refresh()
                .then((latest) => {
                  if (latest) setView({ kind: "policy", policy: latest.policy });
                })
                .catch(() => undefined);
            }}
            onSaved={() => {
              setView(null);
              void resource.refresh().catch(() => undefined);
            }}
          />
        )}
        {view?.kind === "activity" && data && (
          <div className="developer-dialog-stack">
            <FormFeedback error={resource.error} />
            <div className="report-dialog-values">
              <SettingsRow
                icon="quality"
                label="Speaker observation"
                value={humanizeAction(data.speakerState)}
                trailing={<></>}
              />
              <SettingsRow
                icon="calendar"
                label="Observed at"
                value={<RoomConnectionTime value={data.observedAt} />}
                trailing={<></>}
              />
            </div>
            <span className="field-label">Speaking now</span>
            <div className="report-dialog-values">
              {data.speakers.map((speaker) => (
                <SettingsRow
                  key={speaker.participantId}
                  icon="quality"
                  label={name(speaker.participantId)}
                  ariaLabel={speaker.participantId}
                  value={
                    speaker.participantId === data.dominantSpeakerId
                      ? "Dominant speaker"
                      : "Speaking"
                  }
                  trailing={<></>}
                />
              ))}
              {!data.speakers.length && (
                <EmptyState
                  icon="quality"
                  title={
                    data.speakerState === "disabled"
                      ? "Speaker indicators are disabled."
                      : data.speakerState === "unavailable"
                        ? "Speaker observation is currently unavailable."
                        : "No observed speakers"
                  }
                  description={
                    data.speakerState === "disabled"
                      ? "Enable speaker indicators in the activity policy to see who is speaking."
                      : data.speakerState === "unavailable"
                        ? "Live speaker observation will resume when the feed reconnects."
                        : "Last spoke appears below once someone speaks."
                  }
                />
              )}
            </div>
            <span className="field-label">Participant activity</span>
            <div className="report-dialog-values">
              {data.participants.map((participant) => (
                <SettingsRow
                  key={participant.participantId}
                  icon="users"
                  label={name(participant.participantId)}
                  ariaLabel={participant.participantId}
                  value={
                    <span className="room-activity-person-status">
                      <StatusPill active={participant.state === "online"}>
                        {humanizeAction(participant.state)}
                      </StatusPill>
                      <span className="room-last-spoke">
                        {data.speakerState === "disabled" ? (
                          "Speaker indicators disabled"
                        ) : data.speakerState === "unavailable" ? (
                          "Observation unavailable"
                        ) : speaking.has(participant.participantId) ? (
                          "Speaking now"
                        ) : resource.lastSpoke.has(participant.participantId) ? (
                          <>
                            Last spoke{" "}
                            <AnimatedValue
                              value={formatDuration(
                                Math.max(
                                  0,
                                  now - (resource.lastSpoke.get(participant.participantId) ?? now),
                                ),
                              )}
                            />{" "}
                            ago
                          </>
                        ) : (
                          "Not observed yet"
                        )}
                      </span>
                    </span>
                  }
                  trailing={<></>}
                />
              ))}
              {!data.participants.length && (
                <PanelMessage className="account-panel-message">
                  No participant activity to show.
                </PanelMessage>
              )}
            </div>
            {data.truncated && (
              <p className="account-note">Showing activity for the first 512 participants.</p>
            )}
            <p className="account-note">
              Away and inactive describe browser activity. Unknown can mean a hidden tab, reconnect
              or expired heartbeat. Hidden respects participant privacy. Last spoke tracks speech
              observed while this room overview is open.
            </p>
            <Button
              onClick={() => {
                setView(null);
              }}
            >
              Done
            </Button>
          </div>
        )}
      </Dialog>
    </>
  );
}

function ActivityPolicyForm({
  base,
  policy,
  canOperate,
  onBusy,
  onSaved,
  onReload,
}: {
  base: string;
  policy: RoomActivityPolicy;
  canOperate: boolean;
  onBusy: (value: boolean) => void;
  onSaved: () => void;
  onReload: () => void;
}) {
  const [activityEnabled, setActivity] = useState(policy.activityEnabled);
  const [speakersEnabled, setSpeakers] = useState(policy.speakersEnabled);
  const mutation = useDeveloperMutation(onBusy);
  const { notify } = useNotifications();
  return (
    <form
      className="account-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void mutation.run(async () => {
          if (!canOperate) return;
          await accountRequest(
            `${base}/activity-policy`,
            {
              version: policy.version,
              activityEnabled,
              speakersEnabled,
              idleSeconds: Number(form.get("idleSeconds")),
              heartbeatSeconds: Number(form.get("heartbeatSeconds")),
            },
            undefined,
            { method: "PUT" },
          );
          notify("Activity policy saved");
          onSaved();
        });
      }}
    >
      <fieldset disabled={!canOperate || mutation.pending}>
        <div className="workspace-protection">
          <span className="field-label">Activity indicators</span>
          <Switch checked={activityEnabled} onChange={setActivity} label="Activity indicators" />
        </div>
        <div className="workspace-protection">
          <span className="field-label">Speaker indicators</span>
          <Switch checked={speakersEnabled} onChange={setSpeakers} label="Speaker indicators" />
        </div>
        <Field label="Idle threshold (seconds)">
          <input
            className="input"
            name="idleSeconds"
            type="number"
            min={30}
            max={3600}
            defaultValue={policy.idleSeconds}
            required
          />
        </Field>
        <Field label="Heartbeat expiry (seconds)">
          <input
            className="input"
            name="heartbeatSeconds"
            type="number"
            min={30}
            max={120}
            defaultValue={policy.heartbeatSeconds}
            required
          />
        </Field>
        <p className="account-note">
          Activity indicators reflect browser activity. Speaker indicators use observed room audio
          and respect participant privacy settings.
        </p>
        <FormFeedback error={mutation.error} />
        {mutation.error && (
          <Button type="button" onClick={onReload}>
            Reload policy
          </Button>
        )}
        <Button type="submit" variant="primary">
          {mutation.pending ? "Saving…" : "Save changes"}
        </Button>
      </fieldset>
    </form>
  );
}
