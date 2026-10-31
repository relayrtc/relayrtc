"use client";

import { useState } from "react";
import type { ParticipantAccess, UpdateParticipantAccess } from "@relayrtc/types";
import { roomParticipantPermissions } from "@relayrtc/types";
import { accountRequest } from "@/lib/account-api";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/checkbox";
import { Switch } from "@/ui/switch";
import { RoomPermissions } from "./room-permissions";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useDeveloperMutation } from "./use-developer-mutation";
import { useNotifications } from "./notification-provider";

export function RoomParticipantAccess({
  base,
  participantId,
  canOperate,
  onBusy,
  onChanged,
  onBack,
}: {
  base: string;
  participantId: string;
  canOperate: boolean;
  onBusy: (value: boolean) => void;
  onChanged: () => void;
  onBack: () => void;
}) {
  const path = `${base}/participants/${encodeURIComponent(participantId)}/access`;
  const resource = useWorkspaceResource<ParticipantAccess>(path);
  const [busy, setBusy] = useState(false);
  return (
    <section className="developer-dialog-stack" aria-label="Room access">
      <Button disabled={busy} icon="chevronLeft" onClick={onBack}>
        Connection details
      </Button>
      <FormFeedback error={resource.error} />
      {resource.data && (
        <AccessForm
          key={resource.data.version}
          path={path}
          access={resource.data}
          canOperate={canOperate}
          onReload={() => {
            void resource.refresh().catch(() => undefined);
          }}
          onBusy={(value) => {
            setBusy(value);
            onBusy(value);
          }}
          onChanged={async () => {
            await resource.refresh();
            onChanged();
            onBack();
          }}
        />
      )}
      {!resource.data && !resource.error && (
        <p className="account-note" role="status">
          Loading access policy…
        </p>
      )}
      {resource.error && (
        <Button
          disabled={resource.loading || busy}
          onClick={() => void resource.refresh().catch(() => undefined)}
        >
          Try again
        </Button>
      )}
    </section>
  );
}

function AccessForm({
  path,
  access,
  canOperate,
  onBusy,
  onChanged,
  onReload,
}: {
  path: string;
  access: ParticipantAccess;
  canOperate: boolean;
  onBusy: (value: boolean) => void;
  onChanged: () => Promise<void>;
  onReload: () => void;
}) {
  const [role, setRole] = useState(access.role);
  const [restricted, setRestricted] = useState(access.allowedPermissions !== null);
  const [permissions, setPermissions] = useState<readonly string[]>(
    access.allowedPermissions ?? roomParticipantPermissions,
  );
  const [confirmed, setConfirmed] = useState(false);
  const mutation = useDeveloperMutation(onBusy);
  const { notify } = useNotifications();
  const transfer = role === "host" && access.role !== "host";
  return (
    <form
      className="account-form"
      onSubmit={(event) => {
        event.preventDefault();
        void mutation.run(async () => {
          const input: UpdateParticipantAccess = {
            version: access.version,
            role,
            allowedPermissions: restricted
              ? roomParticipantPermissions.filter((value) => permissions.includes(value))
              : null,
          };
          await accountRequest(path, input, undefined, { method: "PUT" });
          notify("Room access policy saved");
          await onChanged();
        });
      }}
    >
      <fieldset disabled={!canOperate || mutation.pending}>
        <Field label="Room role">
          <Select
            className="input"
            value={role}
            onChange={(event) => {
              setRole(event.target.value as ParticipantAccess["role"]);
              setConfirmed(false);
            }}
          >
            <option value="participant" disabled={access.role === "host"}>
              Participant
            </option>
            <option value="moderator" disabled={access.role === "host"}>
              Moderator
            </option>
            <option value="host">Host</option>
          </Select>
        </Field>
        <p className="account-note">
          Hosts manage room roles. Moderators can restrict ordinary participants. Assigning a host
          transfers ownership from the current host.
        </p>
        <div className="workspace-protection">
          <span className="field-label">Restrict token permissions</span>
          <Switch
            checked={restricted}
            onChange={setRestricted}
            label="Restrict token permissions"
          />
        </div>
        {restricted && <RoomPermissions value={permissions} onChange={setPermissions} />}
        <p className="account-note">
          Permissions remain limited by the signed token. Revoking publication stops the
          corresponding live media. Removing a restriction does not automatically restart capture.
        </p>
        {transfer && (
          <label className="account-checkbox">
            <Checkbox
              checked={confirmed}
              onChange={(event) => {
                setConfirmed(event.target.checked);
              }}
              required
            />
            Transfer host ownership to this participant.
          </label>
        )}
        <FormFeedback error={mutation.error} />
        {mutation.error && (
          <Button type="button" onClick={onReload}>
            Reload access policy
          </Button>
        )}
        {canOperate && (
          <Button
            type="submit"
            variant="primary"
            disabled={mutation.pending || (transfer && !confirmed)}
          >
            {mutation.pending ? "Saving…" : "Save room access"}
          </Button>
        )}
      </fieldset>
    </form>
  );
}
