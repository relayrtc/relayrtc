"use client";

import { useState } from "react";
import type { RoomLifecycle as Policy } from "@relayrtc/types";
import { accountRequest } from "@/lib/account-api";
import { roomApiPath } from "@/lib/room-api";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { ReportSection } from "@/ui/report-controls";
import { RoomConnectionTime } from "@/ui/room-connection-time";
import { SettingsRow } from "@/ui/settings-row";
import { Switch } from "@/ui/switch";
import { PanelMessage } from "@/ui/panel-message";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useDeveloperMutation } from "./use-developer-mutation";
import { useNotifications } from "./notification-provider";

function localDeadline(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

export function RoomLifecycleControls({
  projectId,
  roomId,
  canOperate,
}: {
  projectId: string;
  roomId: string;
  canOperate: boolean;
}) {
  const base = roomApiPath(projectId, roomId);
  const resource = useWorkspaceResource<Policy>(`${base}/lifecycle`);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const policy = resource.data;
  return (
    <>
      <ReportSection title="Admission and lifecycle">
        {policy ? (
          <>
            <SettingsRow
              icon="shield"
              label="Room admission"
              value={policy.locked ? "Locked" : "Open"}
              onClick={
                canOperate
                  ? () => {
                      setEditing(true);
                    }
                  : undefined
              }
              trailing={canOperate ? undefined : <></>}
            />
            <SettingsRow
              icon="calendar"
              label="Room deadline"
              value={policy.endsAt ? <RoomConnectionTime value={policy.endsAt} /> : "No deadline"}
              onClick={
                canOperate
                  ? () => {
                      setEditing(true);
                    }
                  : undefined
              }
              trailing={canOperate ? undefined : <></>}
            />
          </>
        ) : (
          <PanelMessage className="account-panel-message" role="status">
            {resource.error ? "Room policy unavailable." : "Loading room policy…"}
          </PanelMessage>
        )}
        <SettingsRow
          icon="link"
          label="Invitations"
          value="Manage room access"
          href={`/rooms/${encodeURIComponent(roomId)}/invitations`}
        />
        <SettingsRow
          icon="history"
          label="Audit log"
          value="View room history"
          href={`/rooms/${encodeURIComponent(roomId)}/audit`}
        />
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
      {policy?.warning && (
        <p className="account-section-note">This room is approaching its deadline.</p>
      )}
      <Dialog
        open={editing && !!policy}
        title="Admission and lifecycle"
        description="Control new admissions and when this room ends."
        dismissible={!busy}
        onClose={() => {
          setEditing(false);
        }}
      >
        {editing && policy && (
          <LifecycleForm
            key={policy.version}
            base={base}
            policy={policy}
            canOperate={canOperate}
            onBusy={setBusy}
            onReload={() => {
              void resource.refresh().catch(() => undefined);
            }}
            onSaved={() => {
              setEditing(false);
              void resource.refresh().catch(() => undefined);
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function LifecycleForm({
  base,
  policy,
  canOperate,
  onBusy,
  onSaved,
  onReload,
}: {
  base: string;
  policy: Policy;
  canOperate: boolean;
  onBusy: (value: boolean) => void;
  onSaved: () => void;
  onReload: () => void;
}) {
  const [locked, setLocked] = useState(policy.locked);
  const [deadline, setDeadline] = useState(() => localDeadline(policy.endsAt));
  const mutation = useDeveloperMutation(onBusy);
  const { notify } = useNotifications();
  return (
    <form
      className="account-form"
      onSubmit={(event) => {
        event.preventDefault();
        void mutation.run(async () => {
          if (!canOperate) return;
          await accountRequest(
            `${base}/lifecycle`,
            {
              version: policy.version,
              locked,
              endsAt:
                deadline === localDeadline(policy.endsAt)
                  ? policy.endsAt
                  : deadline
                    ? new Date(deadline).toISOString()
                    : null,
            },
            undefined,
            { method: "PUT" },
          );
          notify("Room policy saved");
          onSaved();
        });
      }}
    >
      <fieldset disabled={!canOperate || mutation.pending}>
        <div className="workspace-protection">
          <span className="field-label">Lock new admissions</span>
          <Switch checked={locked} onChange={setLocked} label="Lock new admissions" />
        </div>
        <p className="account-note">
          Existing participants stay connected. Reconnects follow the existing grace period.
        </p>
        <Field label="Deadline">
          <input
            className="input"
            type="datetime-local"
            step={1}
            value={deadline}
            onChange={(event) => {
              setDeadline(event.target.value);
            }}
          />
        </Field>
        <p className="account-note">
          Choose a time within the next seven days, in your local timezone. Leave empty for an
          untimed room.
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
