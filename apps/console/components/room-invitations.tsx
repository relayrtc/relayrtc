"use client";

import { useState } from "react";
import { roomParticipantPermissions, type RoomInvitation } from "@relayrtc/types";
import { accountRequest } from "@/lib/account-api";
import { roomApiPath } from "@/lib/room-api";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Dialog } from "@/ui/dialog";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { OneTimeSecret } from "@/ui/developer-fields";
import { Icon } from "@/ui/icon";
import { PanelMessage } from "@/ui/panel-message";
import { SettingsRow } from "@/ui/settings-row";
import { AnimatedValue } from "@/ui/sliding-number";
import { StatusPill } from "@/ui/status-pill";
import { RoomConnectionTime } from "@/ui/room-connection-time";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useConnectionClock } from "./use-realtime-refresh";
import { useDeveloperMutation } from "./use-developer-mutation";
import { useNotifications } from "./notification-provider";
import { RoomPermissions } from "./room-permissions";

interface Page {
  nodes: RoomInvitation[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
type View = { kind: "create" | "redeem" } | { kind: "details"; invitation: RoomInvitation };

function invitationStatus(invitation: RoomInvitation, now: number) {
  if (invitation.revokedAt) return "Revoked";
  if (invitation.uses >= invitation.maxUses) return "Used up";
  if (Date.parse(invitation.expiresAt) <= now) return "Expired";
  return "Active";
}

export function RoomInvitations({
  projectId,
  roomId,
  canOperate,
  canRedeem,
}: {
  projectId: string;
  roomId: string;
  canOperate: boolean;
  canRedeem: boolean;
}) {
  const base = roomApiPath(projectId, roomId);
  const [cursors, setCursors] = useState([""]);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useConnectionClock();
  const query = new URLSearchParams();
  const cursor = cursors[cursors.length - 1];
  if (cursor) query.set("cursor", cursor);
  const resource = useWorkspaceResource<Page>(`${base}/invitations?${query}`);
  function refresh() {
    void resource.refresh().catch(() => undefined);
  }
  function close() {
    setView(null);
  }
  return (
    <>
      {canOperate && (
        <div className="panel">
          <SettingsRow
            icon="plus"
            label="Create invitation"
            onClick={() => {
              setView({ kind: "create" });
            }}
          />
          {canRedeem && (
            <SettingsRow
              icon="secretKeys"
              label="Redeem invitation"
              onClick={() => {
                setView({ kind: "redeem" });
              }}
            />
          )}
        </div>
      )}
      {canOperate && !canRedeem && (
        <p className="account-section-note">
          Participant token signing is unavailable. Invitations can be created, but cannot be
          redeemed from this console.
        </p>
      )}
      <section className="settings-section">
        <div className="account-section-heading">
          <h2>Invitations</h2>
          <button className="auth-text-button" disabled={resource.loading} onClick={refresh}>
            Refresh
          </button>
        </div>
        <FormFeedback error={resource.error} />
        <div className="panel" aria-busy={resource.loading}>
          {resource.data?.nodes.map((invitation) => (
            <button
              className="account-list-row"
              key={invitation.id}
              onClick={() => {
                setView({ kind: "details", invitation });
              }}
            >
              <span className="account-list-icon">
                <Icon name="link" size={21.2625} />
              </span>
              <span className="account-list-copy">
                <span className="account-list-title">
                  {invitation.identity ?? "Any verified identity"}
                </span>
                <span className="account-list-description">
                  {invitation.uses} of {invitation.maxUses} uses · Expires{" "}
                  <RoomConnectionTime value={invitation.expiresAt} />
                </span>
              </span>
              <StatusPill active={invitationStatus(invitation, now) === "Active"}>
                {invitationStatus(invitation, now)}
              </StatusPill>
            </button>
          ))}
          {!resource.data?.nodes.length && (
            <PanelMessage className="account-panel-message" role="status">
              {resource.loading
                ? "Loading invitations…"
                : resource.error
                  ? "Invitations unavailable."
                  : "No invitations on this page."}
            </PanelMessage>
          )}
        </div>
        <div className="account-pagination">
          <button
            className="icon-button"
            aria-label="Previous invitations"
            disabled={resource.loading || cursors.length === 1}
            onClick={() => {
              setCursors((current) => current.slice(0, -1));
            }}
          >
            <Icon name="chevronLeft" size={17.325} />
          </button>
          <span>
            Page <AnimatedValue value={cursors.length} />
          </span>
          <button
            className="icon-button"
            aria-label="Next invitations"
            disabled={resource.loading || !resource.data?.pageInfo.hasNextPage}
            onClick={() => {
              const next = resource.data?.pageInfo.endCursor;
              if (next) setCursors((current) => [...current, next]);
            }}
          >
            <Icon name="chevronRight" size={17.325} />
          </button>
        </div>
        <p className="account-section-note">
          Invitation secrets are shown once. Share them privately with the intended participants.
          Times shown in Casablanca.
        </p>
      </section>
      <Dialog
        open={view !== null}
        title={
          view?.kind === "create"
            ? "Create invitation"
            : view?.kind === "redeem"
              ? "Redeem invitation"
              : "Invitation details"
        }
        dismissible={!busy}
        onClose={close}
      >
        {view?.kind === "create" && (
          <InvitationForm
            base={base}
            mode="create"
            canSubmit={canOperate}
            onBusy={setBusy}
            onChanged={refresh}
            onDone={close}
          />
        )}
        {view?.kind === "redeem" && (
          <InvitationForm
            base={base}
            mode="redeem"
            canSubmit={canRedeem}
            onBusy={setBusy}
            onChanged={refresh}
            onDone={close}
          />
        )}
        {view?.kind === "details" && (
          <InvitationDetails
            base={base}
            invitation={view.invitation}
            status={invitationStatus(view.invitation, now)}
            canOperate={canOperate}
            onBusy={setBusy}
            onDone={() => {
              close();
              refresh();
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function InvitationForm({
  base,
  mode,
  canSubmit,
  onBusy,
  onChanged,
  onDone,
}: {
  base: string;
  mode: "create" | "redeem";
  canSubmit: boolean;
  onBusy: (value: boolean) => void;
  onChanged: () => void;
  onDone: () => void;
}) {
  const mutation = useDeveloperMutation(onBusy);
  const [secret, setSecret] = useState("");
  const [permissions, setPermissions] = useState<readonly string[]>(roomParticipantPermissions);
  const [result, setResult] = useState("");
  const [redemptionId, setRedemptionId] = useState("");
  const { notify } = useNotifications();
  if (result)
    return (
      <OneTimeSecret
        value={result}
        label={mode === "create" ? "Invitation secret" : "Participant token"}
        onDone={onDone}
      />
    );
  return (
    <form
      className="account-form"
      onChange={() => {
        setRedemptionId("");
      }}
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        function text(name: string) {
          const value = form.get(name);
          return typeof value === "string" ? value.trim() : "";
        }
        void mutation.run(async () => {
          if (!canSubmit) return;
          const identity = text("identity");
          if (mode === "create") {
            const created = await accountRequest<{ secret: string }>(`${base}/invitations`, {
              identity: identity || null,
              expiresAt: new Date(text("expiresAt")).toISOString(),
              maxUses: Number(form.get("maxUses")),
              permissions,
            });
            setResult(created.secret);
            notify("Invitation created");
          } else {
            const id = redemptionId || crypto.randomUUID();
            setRedemptionId(id);
            const grant = await accountRequest<{ token: string }>(`${base}/invitations/redeem`, {
              secret: secret.trim(),
              redemptionId: id,
              identity,
              participantName: text("participantName"),
            });
            setResult(grant.token);
            notify("Invitation redeemed");
          }
          onChanged();
        });
      }}
    >
      <fieldset disabled={!canSubmit || mutation.pending}>
        {mode === "redeem" && (
          <Field label="Invitation secret">
            <input
              className="input"
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(event) => {
                setSecret(event.target.value);
              }}
              required
            />
          </Field>
        )}
        <Field label={mode === "create" ? "Identity restriction (optional)" : "Verified identity"}>
          <input className="input" name="identity" maxLength={200} required={mode === "redeem"} />
        </Field>
        {mode === "create" ? (
          <>
            <Field label="Expires at">
              <input className="input" name="expiresAt" type="datetime-local" required />
            </Field>
            <p className="account-note">
              Choose a time within the next seven days, in your local timezone.
            </p>
            <Field label="Maximum uses">
              <input
                className="input"
                name="maxUses"
                type="number"
                min={1}
                max={100}
                defaultValue={1}
                required
              />
            </Field>
            <RoomPermissions value={permissions} onChange={setPermissions} />
          </>
        ) : (
          <>
            <Field label="Participant name">
              <input className="input" name="participantName" maxLength={120} required />
            </Field>
            <p className="account-note">
              Use an identity verified by your application. The resulting token grants the
              invitation’s permissions.
            </p>
          </>
        )}
        <FormFeedback error={mutation.error} />
        <Button type="submit" variant="primary">
          {mutation.pending
            ? "Working…"
            : mode === "create"
              ? "Create invitation"
              : "Redeem invitation"}
        </Button>
      </fieldset>
    </form>
  );
}

function InvitationDetails({
  base,
  invitation,
  status,
  canOperate,
  onBusy,
  onDone,
}: {
  base: string;
  invitation: RoomInvitation;
  status: string;
  canOperate: boolean;
  onBusy: (value: boolean) => void;
  onDone: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const mutation = useDeveloperMutation(onBusy);
  const { notify } = useNotifications();
  return (
    <div className="developer-dialog-stack">
      <dl className="account-detail-list">
        <div>
          <dt>Identity</dt>
          <dd>{invitation.identity ?? "Any verified identity"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <StatusPill active={status === "Active"}>{status}</StatusPill>
          </dd>
        </div>
        <div>
          <dt>Uses</dt>
          <dd>
            {invitation.uses} of {invitation.maxUses}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <RoomConnectionTime value={invitation.createdAt} />
          </dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>
            <RoomConnectionTime value={invitation.expiresAt} />
          </dd>
        </div>
        {invitation.revokedAt && (
          <div>
            <dt>Revoked</dt>
            <dd>
              <RoomConnectionTime value={invitation.revokedAt} />
            </dd>
          </div>
        )}
        <div>
          <dt>Invitation ID</dt>
          <dd>
            <code>{invitation.id}</code>
          </dd>
        </div>
        <div>
          <dt>Permissions</dt>
          <dd>{invitation.permissions.join(", ")}</dd>
        </div>
      </dl>
      <FormFeedback error={mutation.error} />
      {canOperate && status === "Active" && !confirming && (
        <Button
          variant="danger"
          onClick={() => {
            setConfirming(true);
          }}
        >
          Revoke invitation
        </Button>
      )}
      {confirming && (
        <form
          className="account-form"
          onSubmit={(event) => {
            event.preventDefault();
            void mutation.run(async () => {
              if (!canOperate) return;
              await accountRequest(
                `${base}/invitations/${encodeURIComponent(invitation.id)}`,
                undefined,
                undefined,
                { method: "DELETE" },
              );
              notify("Invitation revoked");
              onDone();
            });
          }}
        >
          <fieldset disabled={mutation.pending || !canOperate}>
            <p className="account-note">
              Revoke this invitation? It will no longer accept new redemptions. Existing
              participants stay connected.
            </p>
            <label className="account-checkbox">
              <Checkbox required />I want to revoke this invitation.
            </label>
            <div className="account-button-pair">
              <Button
                type="button"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="danger">
                {mutation.pending ? "Revoking…" : "Revoke invitation"}
              </Button>
            </div>
          </fieldset>
        </form>
      )}
      {!confirming && <Button onClick={onDone}>Done</Button>}
    </div>
  );
}
