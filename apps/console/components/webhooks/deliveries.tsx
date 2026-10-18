"use client";

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, LoaderCircle, RotateCw } from "lucide-react";
import type {
  WebhookDeliveryDetail,
  WebhookDeliveryList,
  WebhookDeliveryStatus,
} from "@relayrtc/types";
import {
  getWebhookDeliveryAction,
  listWebhookDeliveriesAction,
  replayWebhookDeliveryAction,
} from "@/actions/webhooks";
import { AuthErrorMessage } from "@/components/auth/auth-error-message";
import { CopyButton } from "@/components/page/copy-button";
import { SimpleSelect } from "@/components/page/simple-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  unavailableWebhookError,
  type WebhookConfiguration,
  type WebhookError,
} from "@/lib/webhooks/contracts";

const statusOptions = [
  { value: "all", label: "All statuses" },
  { value: "pending", label: "Queued" },
  { value: "delivering", label: "Delivering" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];
const date = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      )
    : "—";

function DeliveryStatus({ status }: { status: WebhookDeliveryStatus }) {
  return (
    <Badge
      variant={
        status === "failed" ? "destructive" : status === "succeeded" ? "secondary" : "outline"
      }
    >
      {statusOptions.find((option) => option.value === status)?.label ?? status}
    </Badge>
  );
}

export function WebhookDeliveries({
  projectId,
  environmentId,
  endpoint,
  canManage,
  onClose,
}: {
  projectId: string;
  environmentId: string;
  endpoint: WebhookConfiguration;
  canManage: boolean;
  onClose: () => void;
}) {
  const [status, setStatus] = useState("all");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<WebhookDeliveryList | null>(null);
  const [error, setError] = useState<WebhookError | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const active = useRef(false);
  const load = useCallback(async () => {
    if (!active.current || inFlight.current) return;
    inFlight.current = true;
    const request = ++sequence.current;
    try {
      const result = await listWebhookDeliveriesAction({
        projectId,
        environmentId,
        endpointId: endpoint.id,
        query: { limit: 50, offset, ...(status === "all" ? {} : { status }) },
      });
      if (sequence.current !== request) return;
      if (result.error) setError(result.error);
      else {
        setData(result.data);
        setError(null);
      }
    } catch {
      if (sequence.current === request) setError(unavailableWebhookError);
    } finally {
      if (sequence.current === request) {
        setLoading(false);
        inFlight.current = false;
      }
    }
  }, [projectId, environmentId, endpoint.id, offset, status]);

  const invalidateRequests = useCallback(() => {
    active.current = false;
    sequence.current++;
    inFlight.current = false;
  }, []);
  useEffect(() => {
    active.current = true;
    const initialLoad = setTimeout(() => void load(), 0);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10_000);
    return () => {
      clearTimeout(initialLoad);
      clearInterval(timer);
      invalidateRequests();
    };
  }, [load, invalidateRequests]);

  function changePage(nextOffset: number) {
    setData(null);
    setLoading(true);
    setOffset(nextOffset);
  }

  return (
    <section className="grid gap-5 border-t pt-6" aria-label="Webhook deliveries">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <Button variant="ghost" size="sm" className="mb-2" onClick={onClose}>
            <ArrowLeft />
            Close deliveries
          </Button>
          <h2 className="text-xl font-medium tracking-tight">Delivery history</h2>
          <p className="mt-1 break-all text-sm text-muted-foreground">{endpoint.url}</p>
        </div>
        <div className="flex items-center gap-2">
          <SimpleSelect
            value={status}
            aria-label="Delivery status"
            options={statusOptions}
            onValueChange={(value) => {
              if (value === status) return;
              setData(null);
              setLoading(true);
              setStatus(value);
              setOffset(0);
            }}
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh delivery history"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            <RotateCw className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>
      <AuthErrorMessage error={error} />
      {loading && !data ? (
        <div
          className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
          role="status"
        >
          <LoaderCircle className="size-4 animate-spin" />
          Loading deliveries…
        </div>
      ) : data?.deliveries.length === 0 ? (
        <div className="rounded-2xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
          {status === "all"
            ? "No deliveries yet. Events will appear here when this endpoint receives them."
            : "No deliveries with this status."}
        </div>
      ) : data ? (
        <div className="overflow-x-auto">
          <Table className="w-full min-w-[40rem] text-sm">
            <TableHeader>
              <TableRow className="border-b text-left text-muted-foreground">
                {["Delivery", "Status", "Attempts", "Updated"].map((label) => (
                  <TableHead key={label} scope="col" className="px-2 pb-3 font-normal">
                    {label}
                  </TableHead>
                ))}
                <TableHead className="w-20 pb-3">
                  <span className="sr-only">Details</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.deliveries.map((delivery) => (
                <TableRow key={delivery.id} className="border-b last:border-0">
                  <TableCell className="max-w-sm px-2 py-4">
                    <p className="break-all font-mono text-[0.8125rem]">{delivery.id}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {date(delivery.createdAt)}
                      {delivery.replayCount > 0 ? ` · Replay ${delivery.replayCount}` : ""}
                    </p>
                  </TableCell>
                  <TableCell className="px-2 py-4">
                    <DeliveryStatus status={delivery.status} />
                  </TableCell>
                  <TableCell className="px-2 py-4 tabular-nums">{delivery.attemptCount}</TableCell>
                  <TableCell className="px-2 py-4 text-muted-foreground">
                    {date(delivery.updatedAt)}
                  </TableCell>
                  <TableCell className="py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Details for ${delivery.id}`}
                      onClick={() => setSelectedId(delivery.id)}
                    >
                      Details
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {data ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p>
            {data.pagination.total === 0
              ? "0 deliveries"
              : `${Math.min(offset + 1, data.pagination.total)}–${Math.min(offset + data.deliveries.length, data.pagination.total)} of ${data.pagination.total} deliveries`}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loading || offset === 0}
              onClick={() => changePage(Math.max(0, offset - 50))}
            >
              <ChevronLeft />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || offset + 50 >= data.pagination.total}
              onClick={() => changePage(offset + 50)}
            >
              Next
              <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Updates every 10 seconds while this page is visible. Completed delivery logs are retained
        for 30 days.
      </p>
      <Dialog
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          {selectedId ? (
            <DeliveryDetails
              key={selectedId}
              projectId={projectId}
              environmentId={environmentId}
              endpointId={endpoint.id}
              deliveryId={selectedId}
              canReplay={canManage && endpoint.status === "enabled"}
              onReplayed={() => {
                void load();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function DeliveryDetails({
  projectId,
  environmentId,
  endpointId,
  deliveryId,
  canReplay,
  onReplayed,
}: {
  projectId: string;
  environmentId: string;
  endpointId: string;
  deliveryId: string;
  canReplay: boolean;
  onReplayed: () => void;
}) {
  const [detail, setDetail] = useState<WebhookDeliveryDetail | null>(null);
  const [error, setError] = useState<WebhookError | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [replayError, setReplayError] = useState<WebhookError | null>(null);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const active = useRef(false);
  const mutation = useRef(false);
  const load = useCallback(async () => {
    if (!active.current || inFlight.current || mutation.current) return;
    inFlight.current = true;
    const request = ++sequence.current;
    try {
      const result = await getWebhookDeliveryAction({
        projectId,
        environmentId,
        endpointId,
        deliveryId,
      });
      if (request !== sequence.current) return;
      if (result.error) setError(result.error);
      else {
        setDetail(result.data);
        setError(null);
      }
    } catch {
      if (request === sequence.current) setError(unavailableWebhookError);
    } finally {
      if (request === sequence.current) {
        setLoading(false);
        inFlight.current = false;
      }
    }
  }, [projectId, environmentId, endpointId, deliveryId]);

  const invalidateRequests = useCallback(() => {
    active.current = false;
    sequence.current++;
    inFlight.current = false;
  }, []);
  useEffect(() => {
    active.current = true;
    const initialLoad = setTimeout(() => void load(), 0);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10_000);
    return () => {
      clearTimeout(initialLoad);
      clearInterval(timer);
      invalidateRequests();
    };
  }, [load, invalidateRequests]);

  async function replay() {
    if (!detail || mutation.current || !canReplay) return;
    mutation.current = true;
    sequence.current++;
    inFlight.current = false;
    setReplaying(true);
    setReplayError(null);
    try {
      const result = await replayWebhookDeliveryAction({
        projectId,
        environmentId,
        endpointId,
        deliveryId,
        replay: { expectedReplayCount: detail.replayCount },
      });
      if (result.error) setReplayError(result.error);
      else {
        setDetail((current) => (current ? { ...current, ...result.data } : current));
        setConfirming(false);
        onReplayed();
      }
    } catch {
      setReplayError(unavailableWebhookError);
    } finally {
      mutation.current = false;
      setReplaying(false);
      if (active.current) void load();
    }
  }

  const replayAllowed =
    canReplay &&
    !error &&
    detail !== null &&
    detail.replayCount < 100 &&
    ["succeeded", "failed", "cancelled"].includes(detail.status);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Delivery details</DialogTitle>
        <DialogDescription>
          Inspect the event, response status and every delivery attempt.
        </DialogDescription>
      </DialogHeader>
      <AuthErrorMessage error={error} />
      {loading && !detail ? (
        <div className="flex items-center gap-2 py-8 text-muted-foreground" role="status">
          <LoaderCircle className="size-4 animate-spin" />
          Loading delivery…
        </div>
      ) : null}
      {detail ? (
        <div className="grid min-w-0 gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{detail.event.type}</Badge>
            <DeliveryStatus status={detail.status} />
            {detail.replayCount > 0 ? (
              <Badge variant="outline">Replay {detail.replayCount}</Badge>
            ) : null}
          </div>
          <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Delivery ID</dt>
              <dd className="mt-1 flex items-center gap-1">
                <code className="break-all text-xs">{detail.id}</code>
                <CopyButton value={detail.id} label="Copy delivery ID" />
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Event ID</dt>
              <dd className="mt-1 flex items-center gap-1">
                <code className="break-all text-xs">{detail.event.id}</code>
                <CopyButton value={detail.event.id} label="Copy event ID" />
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">Delivery URL</dt>
              <dd className="mt-1 break-all">{detail.url}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Event occurred</dt>
              <dd className="mt-1">{date(detail.event.occurredAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Delivered</dt>
              <dd className="mt-1">{date(detail.deliveredAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Attempts in this run</dt>
              <dd className="mt-1">{detail.runAttemptCount} / 8</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Next attempt</dt>
              <dd className="mt-1">{date(detail.nextAttemptAt)}</dd>
            </div>
            {detail.lastError ? (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Last outcome</dt>
                <dd className="mt-1 font-mono text-xs text-destructive">{detail.lastError}</dd>
              </div>
            ) : null}
          </dl>
          <div className="grid gap-2">
            <h3 className="font-medium">Attempts</h3>
            {detail.attempts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This delivery has not been attempted yet.
              </p>
            ) : (
              <div className="max-h-64 overflow-auto">
                <Table className="w-full min-w-[32rem] text-sm">
                  <TableHeader>
                    <TableRow className="border-b text-left text-muted-foreground">
                      {["Attempt", "Outcome", "HTTP", "Signing key", "Started"].map((label) => (
                        <TableHead key={label} scope="col" className="px-2 pb-3 font-normal">
                          {label}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.attempts.map((attempt) => (
                      <TableRow key={attempt.id} className="border-b last:border-0">
                        <TableCell className="px-2 py-3 tabular-nums">
                          {attempt.attemptNumber}
                          <span className="ml-1 text-xs text-muted-foreground">
                            {attempt.replayCount > 0 ? `(replay ${attempt.replayCount})` : ""}
                          </span>
                        </TableCell>
                        <TableCell className="px-2 py-3">
                          <span className="capitalize">{attempt.status}</span>
                          {attempt.errorCode ? (
                            <p className="mt-1 font-mono text-xs text-muted-foreground">
                              {attempt.errorCode}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="px-2 py-3 tabular-nums">
                          {attempt.httpStatus ?? "—"}
                        </TableCell>
                        <TableCell className="px-2 py-3">v{attempt.signingSecretVersion}</TableCell>
                        <TableCell className="px-2 py-3 text-muted-foreground">
                          {date(attempt.startedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
          <div className="grid min-w-0 gap-2">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">Event payload</h3>
              <CopyButton value={detail.rawBody} label="Copy raw event payload" />
            </div>
            <pre className="max-h-64 overflow-auto rounded-xl border bg-muted/40 p-3 text-xs leading-relaxed">
              {JSON.stringify(detail.event, null, 2)}
            </pre>
            <p className="text-xs text-muted-foreground">
              The copy button copies the original request body for signature verification.
            </p>
          </div>
          {confirming ? (
            <div className="grid gap-3 rounded-xl border bg-muted/40 p-4">
              <p className="font-medium">Replay this delivery?</p>
              <p className="text-sm text-muted-foreground">
                Send the same event again using this endpoint&apos;s current URL and signing secret.
                The event and delivery IDs stay the same. Your receiver should deduplicate events by
                event ID.
              </p>
              <AuthErrorMessage error={replayError} />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  disabled={replaying}
                  onClick={() => {
                    setConfirming(false);
                    setReplayError(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  disabled={replaying || !replayAllowed}
                  onClick={() => {
                    void replay();
                  }}
                >
                  {replaying ? <LoaderCircle className="animate-spin" /> : <RotateCw />}Confirm
                  replay
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <DialogFooter>
        <Button
          variant="ghost"
          disabled={loading || replaying}
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          <RotateCw className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
        {canReplay ? (
          <Button
            disabled={!replayAllowed || loading || replaying || confirming}
            onClick={() => {
              setConfirming(true);
              setReplayError(null);
            }}
          >
            <RotateCw />
            Replay delivery
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
