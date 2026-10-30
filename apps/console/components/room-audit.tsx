"use client";

import { useState } from "react";
import type { RoomAuditEvent } from "@relayrtc/types";
import { roomApiPath } from "@/lib/room-api";
import { humanizeAction } from "@/lib/account-display";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { Icon } from "@/ui/icon";
import { PanelMessage } from "@/ui/panel-message";
import { SettingsRow } from "@/ui/settings-row";
import { AnimatedValue } from "@/ui/sliding-number";
import { RoomConnectionTime } from "@/ui/room-connection-time";
import { useWorkspaceResource } from "./use-workspace-resource";

interface Page {
  nodes: RoomAuditEvent[];
  pageInfo: { hasNextPage: boolean; endCursor: { before: string; cursor: string } | null };
}
const emptyFilters = { action: "", actorId: "", participantId: "" };

export function RoomAudit({ projectId, roomId }: { projectId: string; roomId: string }) {
  const [filters, setFilters] = useState(emptyFilters);
  const [cursors, setCursors] = useState([""]);
  const [filtering, setFiltering] = useState(false);
  const [selected, setSelected] = useState<RoomAuditEvent | null>(null);
  const query = new URLSearchParams({ limit: "30" });
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const resource = useWorkspaceResource<Page>(
    `${roomApiPath(projectId, roomId)}/audit?${query}${cursors[cursors.length - 1]}`,
  );
  const count = Object.values(filters).filter(Boolean).length;
  return (
    <>
      <div className="panel">
        <SettingsRow
          icon="search"
          label="Filter audit log"
          value={count ? `${String(count)} active` : "All events"}
          onClick={() => {
            setFiltering(true);
          }}
        />
      </div>
      <section className="settings-section" aria-label="Room audit log">
        <div className="account-section-heading">
          <h2>Recent activity</h2>
          <button
            className="auth-text-button"
            disabled={resource.loading}
            onClick={() => {
              void resource.refresh().catch(() => undefined);
            }}
          >
            Refresh
          </button>
        </div>
        <FormFeedback error={resource.error} />
        <div className="panel" aria-busy={resource.loading}>
          {resource.data?.nodes.map((entry) => (
            <button
              className="account-list-row"
              key={entry.id}
              onClick={() => {
                setSelected(entry);
              }}
            >
              <span className="account-list-icon">
                <Icon name="history" size={21.2625} />
              </span>
              <span className="account-list-copy">
                <span className="account-list-title">{humanizeAction(entry.action)}</span>
                <span className="account-list-description">
                  <RoomConnectionTime value={entry.occurredAt} /> · {entry.actorName}
                </span>
              </span>
              <span
                className={`account-outcome ${entry.outcome.toLowerCase() === "failure" ? "account-outcome-failure" : ""}`}
              >
                {humanizeAction(entry.outcome.toLowerCase())}
              </span>
            </button>
          ))}
          {!resource.data?.nodes.length && (
            <PanelMessage className="account-panel-message" role="status">
              {resource.loading
                ? "Loading audit log…"
                : resource.error
                  ? "Audit log unavailable."
                  : "No events match these filters."}
            </PanelMessage>
          )}
        </div>
        <div className="account-pagination">
          <button
            className="icon-button"
            aria-label="Previous events"
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
            aria-label="Older events"
            disabled={resource.loading || !resource.data?.pageInfo.hasNextPage}
            onClick={() => {
              const next = resource.data?.pageInfo.endCursor;
              if (next) setCursors((current) => [...current, `&${new URLSearchParams(next)}`]);
            }}
          >
            <Icon name="chevronRight" size={17.325} />
          </button>
        </div>
        <p className="account-section-note">
          Audit events are immutable. Times are shown in Casablanca. Account audit retention
          applies.
        </p>
      </section>
      <Dialog
        open={filtering}
        title="Filter audit log"
        onClose={() => {
          setFiltering(false);
        }}
      >
        {filtering && (
          <AuditFilters
            initial={filters}
            onApply={(value) => {
              setFilters(value);
              setCursors([""]);
              setFiltering(false);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={selected !== null}
        title="Room audit event"
        onClose={() => {
          setSelected(null);
        }}
      >
        {selected && (
          <div className="developer-dialog-stack">
            <dl className="account-detail-list">
              <div>
                <dt>Action</dt>
                <dd>{humanizeAction(selected.action)}</dd>
              </div>
              <div>
                <dt>Occurred</dt>
                <dd>
                  <RoomConnectionTime value={selected.occurredAt} />
                </dd>
              </div>
              <div>
                <dt>Actor</dt>
                <dd>
                  {selected.actorName} ({selected.actorType})
                </dd>
              </div>
              <div>
                <dt>Actor ID</dt>
                <dd>{selected.actorId ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt>Outcome</dt>
                <dd>{humanizeAction(selected.outcome.toLowerCase())}</dd>
              </div>
              <div>
                <dt>Resource</dt>
                <dd>{selected.resourceType}</dd>
              </div>
              <div>
                <dt>Resource ID</dt>
                <dd>{selected.resourceId ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt>Event ID</dt>
                <dd>
                  <code>{selected.id}</code>
                </dd>
              </div>
              <div>
                <dt>Request ID</dt>
                <dd>
                  <code>{selected.correlationId ?? "Unavailable"}</code>
                </dd>
              </div>
            </dl>
            {Object.keys(selected.metadata).length > 0 && (
              <pre className="account-event-metadata developer-payload">
                {JSON.stringify(selected.metadata, null, 2)}
              </pre>
            )}
            <Button
              onClick={() => {
                setSelected(null);
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

function AuditFilters({
  initial,
  onApply,
}: {
  initial: typeof emptyFilters;
  onApply: (value: typeof emptyFilters) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <form
      className="account-form"
      onSubmit={(event) => {
        event.preventDefault();
        onApply({
          action: draft.action.trim(),
          actorId: draft.actorId.trim(),
          participantId: draft.participantId.trim(),
        });
      }}
    >
      <fieldset>
        <Field label="Action">
          <input
            className="input"
            value={draft.action}
            onChange={(event) => {
              setDraft((current) => ({ ...current, action: event.target.value }));
            }}
            maxLength={160}
            placeholder="room.participant_access_updated"
          />
        </Field>
        <Field label="Actor ID">
          <input
            className="input"
            value={draft.actorId}
            onChange={(event) => {
              setDraft((current) => ({ ...current, actorId: event.target.value }));
            }}
            maxLength={128}
          />
        </Field>
        <Field label="Participant ID">
          <input
            className="input"
            value={draft.participantId}
            onChange={(event) => {
              setDraft((current) => ({ ...current, participantId: event.target.value }));
            }}
            maxLength={128}
          />
        </Field>
        <div className="account-button-pair">
          <Button
            type="button"
            onClick={() => {
              onApply(emptyFilters);
            }}
          >
            Reset filters
          </Button>
          <Button type="submit" variant="primary">
            Apply filters
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
