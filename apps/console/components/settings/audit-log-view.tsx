"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Download,
  Eye,
  Fingerprint,
  History,
  KeyRound,
  LoaderCircle,
  Monitor,
  RotateCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  XCircle,
} from "lucide-react";
import { CopyButton } from "@/components/page/copy-button";
import { PageHeader } from "@/components/page/page-header";
import { Panel } from "@/components/page/panel";
import { SimpleSelect } from "@/components/page/simple-select";
import { SettingList, SettingRow } from "@/components/page/setting-row";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { accountRequest } from "@/lib/account-api";

interface AuditEvent {
  id: string;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  actorName: string;
  action: string;
  outcome: string;
  resourceType: string;
  resourceId: string | null;
  correlationId: string | null;
  metadata: Record<string, string | number | boolean | null>;
}
interface AuditPage {
  events: AuditEvent[];
  nextCursor: string | null;
  retentionDays: number;
}
const actors = [
  { value: "all", label: "All actors" },
  { value: "USER", label: "Users" },
  { value: "SYSTEM", label: "System" },
  { value: "API_KEY", label: "API keys" },
  { value: "ANONYMOUS", label: "Anonymous" },
];
const outcomes = [
  { value: "all", label: "All outcomes" },
  { value: "SUCCESS", label: "Success" },
  { value: "FAILURE", label: "Failure" },
  { value: "ATTEMPT", label: "Attempt" },
];
const humanize = (value: string) =>
  value.replaceAll(/[._-]/g, " ").replace(/^./, (char) => char.toUpperCase());
const actorLabel = (type: string) =>
  ({ USER: "User", SYSTEM: "System", API_KEY: "API key", ANONYMOUS: "Anonymous" })[type] ??
  humanize(type);
function eventIcon(event: AuditEvent) {
  if (/password|backup|api_key/.test(event.action)) return KeyRound;
  if (/session|sign.in|sign.out/.test(event.action)) return Monitor;
  if (/two.factor|mfa/.test(event.action)) return ShieldCheck;
  if (/profile|email|user/.test(event.action)) return UserRound;
  return History;
}
function Outcome({ value }: { value: string }) {
  const Icon = value === "SUCCESS" ? CheckCircle2 : value === "FAILURE" ? XCircle : CircleDashed;
  return (
    <Badge
      variant={value === "FAILURE" ? "destructive" : "secondary"}
      className={value === "SUCCESS" ? "bg-success/10 text-success" : undefined}
    >
      <Icon />
      {humanize(value.toLowerCase())}
    </Badge>
  );
}
function Actor({ event }: { event: AuditEvent }) {
  const Icon =
    event.actorType === "SYSTEM"
      ? Bot
      : event.actorType === "API_KEY"
        ? KeyRound
        : event.actorType === "ANONYMOUS"
          ? Fingerprint
          : UserRound;
  return (
    <div className="flex items-center gap-2.5">
      <Avatar size="sm">
        <AvatarFallback>
          <Icon className="size-4" />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{event.actorName}</p>
        <p className="text-xs text-muted-foreground">{actorLabel(event.actorType)}</p>
      </div>
    </div>
  );
}
function Reference({ value }: { value: string | null }) {
  return value ? (
    <span className="inline-flex max-w-full items-center gap-1">
      <code className="break-all text-xs">{value}</code>
      <CopyButton value={value} />
    </span>
  ) : (
    <span className="text-muted-foreground">Not available</span>
  );
}

export function AccountAuditLog({ organizationId }: { organizationId?: string }) {
  return (
    <AuditLogView
      key={organizationId ?? "personal"}
      {...(organizationId ? { organizationId } : {})}
    />
  );
}

function AuditLogView({ organizationId }: { organizationId?: string }) {
  const [page, setPage] = useState<AuditPage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [action, setAction] = useState("");
  const [actorType, setActorType] = useState("all");
  const [outcome, setOutcome] = useState("all");
  const [filters, setFilters] = useState("");
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const sequence = useRef(0);
  const endpoint = organizationId
    ? `/api/account/organizations/${encodeURIComponent(organizationId)}/audit`
    : "/api/account/audit";
  const load = useCallback(
    async (nextCursors: Array<string | undefined>) => {
      const request = ++sequence.current;
      const query = new URLSearchParams(filters);
      const cursor = nextCursors.at(-1);
      if (cursor) query.set("cursor", cursor);
      setBusy(true);
      setError("");
      try {
        const result = await accountRequest<AuditPage>(`${endpoint}?${query}`);
        if (request === sequence.current) {
          setPage(result);
          setCursors(nextCursors);
        }
      } catch (error) {
        if (request === sequence.current)
          setError(error instanceof Error ? error.message : "Unable to load audit history.");
      } finally {
        if (request === sequence.current) setBusy(false);
      }
    },
    [endpoint, filters],
  );
  useEffect(() => {
    let active = true;
    const request = ++sequence.current;
    accountRequest<AuditPage>(`${endpoint}?${filters}`)
      .then((page) => {
        if (active && request === sequence.current) setPage(page);
      })
      .catch((error: Error) => {
        if (active && request === sequence.current) setError(error.message);
      })
      .finally(() => {
        if (active && request === sequence.current) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [endpoint, filters]);
  async function exportPage() {
    setExporting(true);
    setError("");
    try {
      const exported = await accountRequest<AuditPage>(`${endpoint}/export?${filters}`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = organizationId
        ? "relayrtc-organization-audit.json"
        : "relayrtc-personal-audit.json";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to export history.");
    } finally {
      setExporting(false);
    }
  }
  function applyFilters(clear = false) {
    const query = new URLSearchParams();
    if (!clear) {
      if (action.trim()) query.set("action", action.trim());
      if (actorType !== "all") query.set("actorType", actorType);
      if (outcome !== "all") query.set("outcome", outcome);
    } else {
      setAction("");
      setActorType("all");
      setOutcome("all");
    }
    const next = query.toString();
    if (next === filters) {
      void load([undefined]);
      return;
    }
    setBusy(true);
    setError("");
    setPage(null);
    setCursors([undefined]);
    setFilters(next);
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={organizationId ? "Organization audit logs" : "Personal audit logs"}
        description={
          organizationId
            ? "A record of organization activity from users, API keys and system processes."
            : "Your account activity and security changes, including actions performed by the system."
        }
        actions={
          <>
            <Button
              variant="outline"
              disabled={busy || exporting}
              onClick={() => void load(cursors)}
            >
              <RotateCw className={busy ? "animate-spin" : ""} />
              Refresh
            </Button>
            <Button
              variant="outline"
              disabled={busy || exporting || !page?.events.length}
              onClick={() => void exportPage()}
            >
              {exporting ? <LoaderCircle className="animate-spin" /> : <Download />}Export logs
            </Button>
          </>
        }
      />
      <Panel className="border">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters();
          }}
        >
          <div className="grid min-w-48 flex-1 gap-2">
            <Label htmlFor="audit-action">Action</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="audit-action"
                className="h-10 rounded-full pl-9"
                placeholder="Exact action, e.g. account.password_reset"
                value={action}
                onChange={(event) => setAction(event.target.value)}
                maxLength={160}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="audit-actor">Actor</Label>
            <SimpleSelect
              id="audit-actor"
              value={actorType}
              onValueChange={setActorType}
              options={actors}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="audit-outcome">Outcome</Label>
            <SimpleSelect
              id="audit-outcome"
              value={outcome}
              onValueChange={setOutcome}
              options={outcomes}
            />
          </div>
          <Button type="submit" variant="outline" className="h-10" disabled={busy || exporting}>
            <SlidersHorizontal />
            Apply filters
          </Button>
          {filters ? (
            <Button
              type="button"
              variant="ghost"
              className="h-10"
              disabled={busy || exporting}
              onClick={() => applyFilters(true)}
            >
              Clear
            </Button>
          ) : null}
        </form>
      </Panel>
      {error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Unable to load or export audit logs</AlertTitle>
          <AlertDescription>
            {error}
            <Button
              variant="ghost"
              className="ml-2"
              disabled={busy}
              onClick={() => void load(cursors)}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <Panel className="overflow-hidden border p-0 sm:p-0" aria-busy={busy}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-4">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <History className="size-4 text-muted-foreground" />
            Activity history
          </h2>
          <Badge variant="secondary">
            {page ? `${page.events.length} events on this page` : busy ? "Loading" : "Unavailable"}
          </Badge>
        </div>
        {!page && busy ? (
          <div role="status" aria-label="Loading audit history" className="grid gap-5 p-5">
            {[0, 1, 2, 3].map((key) => (
              <div key={key} className="flex gap-3">
                <Skeleton className="size-9 rounded-xl" />
                <div className="grid flex-1 gap-2">
                  <Skeleton className="h-4 w-52" />
                  <Skeleton className="h-3 w-36" />
                </div>
                <Skeleton className="hidden h-5 w-20 sm:block" />
              </div>
            ))}
          </div>
        ) : null}
        {page?.events.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-sm">
              <caption className="sr-only">
                {organizationId ? "Organization" : "Personal"} audit events
              </caption>
              <thead className="bg-muted/40">
                <tr className="border-b text-left text-xs text-muted-foreground">
                  {["Event", "Actor", "Outcome", "Date", ""].map((heading) => (
                    <th key={heading} scope="col" className="px-5 py-3 font-medium">
                      {heading || <span className="sr-only">Details</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.events.map((event) => {
                  const Icon = eventIcon(event);
                  return (
                    <tr
                      key={event.id}
                      className="border-b transition-colors last:border-b-0 hover:bg-muted/30"
                    >
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                            <Icon className="size-4" />
                          </div>
                          <div>
                            <button
                              type="button"
                              className="text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() => setSelected(event)}
                            >
                              {humanize(event.action)}
                            </button>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {humanize(event.resourceType)}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <Actor event={event} />
                      </td>
                      <td className="px-5 py-4">
                        <Outcome value={event.outcome} />
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-xs text-muted-foreground">
                        <time dateTime={event.occurredAt}>
                          <span className="block">
                            {new Date(event.occurredAt).toLocaleDateString(undefined, {
                              dateStyle: "medium",
                            })}
                          </span>
                          <span className="mt-1 block">
                            {new Date(event.occurredAt).toLocaleTimeString(undefined, {
                              timeStyle: "short",
                            })}
                          </span>
                        </time>
                      </td>
                      <td className="px-3 py-4">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`View ${event.action} details`}
                          onClick={() => setSelected(event)}
                        >
                          <Eye />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {page && !page.events.length && !busy ? (
          <div className="flex flex-col items-center gap-2 px-5 py-14 text-center">
            <div className="mb-2 rounded-2xl bg-muted p-4">
              <History className="size-6 text-muted-foreground" />
            </div>
            <h3 className="font-medium">{filters ? "No matching events" : "No activity yet"}</h3>
            <p className="max-w-sm text-sm text-muted-foreground">
              {filters
                ? "Try changing or clearing your filters."
                : "Account and security activity will appear here."}
            </p>
            {filters ? (
              <Button variant="outline" className="mt-3" onClick={() => applyFilters(true)}>
                Clear filters
              </Button>
            ) : null}
          </div>
        ) : null}
      </Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock3 className="size-3.5" />
          Retained for {page?.retentionDays ?? 365} days. Exports include up to 100 matching events.
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || exporting || cursors.length < 2}
            onClick={() => void load(cursors.slice(0, -1))}
          >
            <ArrowLeft />
            Newer
          </Button>
          <span className="text-xs text-muted-foreground">Page {cursors.length}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || exporting || !page?.nextCursor}
            onClick={() => {
              if (page?.nextCursor) void load([...cursors, page.nextCursor]);
            }}
          >
            Older
            <ArrowRight />
          </Button>
        </div>
      </div>
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Event details</SheetTitle>
            <SheetDescription>Actor, outcome and references for this audit event.</SheetDescription>
          </SheetHeader>
          {selected ? (
            <div className="grid gap-6 px-4 pb-6">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-muted p-3">
                  <History className="size-5 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-medium">{humanize(selected.action)}</h2>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {selected.action}
                  </p>
                </div>
              </div>
              <SettingList>
                <SettingRow label="Outcome">
                  <Outcome value={selected.outcome} />
                </SettingRow>
                <SettingRow label="Actor">
                  <Actor event={selected} />
                </SettingRow>
                <SettingRow label="Actor ID">
                  <Reference value={selected.actorId} />
                </SettingRow>
                <SettingRow label="Occurred">
                  <time dateTime={selected.occurredAt}>
                    {new Date(selected.occurredAt).toLocaleString()}
                  </time>
                </SettingRow>
                <SettingRow label="Resource">{humanize(selected.resourceType)}</SettingRow>
                <SettingRow label="Resource ID">
                  <Reference value={selected.resourceId} />
                </SettingRow>
                <SettingRow label="Request ID">
                  <Reference value={selected.correlationId} />
                </SettingRow>
                <SettingRow label="Event ID">
                  <Reference value={selected.id} />
                </SettingRow>
              </SettingList>
              <div>
                <h3 className="mb-3 text-sm font-medium">Additional details</h3>
                {Object.entries(selected.metadata).some(([, value]) => value !== null) ? (
                  <SettingList>
                    {Object.entries(selected.metadata)
                      .filter(([, value]) => value !== null)
                      .map(([key, value]) => (
                        <SettingRow key={key} label={humanize(key)}>
                          <span className="break-all">{String(value)}</span>
                        </SettingRow>
                      ))}
                  </SettingList>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No additional details for this event.
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
