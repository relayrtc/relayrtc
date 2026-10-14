"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarClock,
  Clock3,
  Globe2,
  LoaderCircle,
  LogOut,
  Monitor,
  RotateCw,
  ShieldCheck,
  Smartphone,
  Tablet,
} from "lucide-react";
import { PageHeader } from "@/components/page/page-header";
import { Panel } from "@/components/page/panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Skeleton } from "@/components/ui/skeleton";
import { accountRequest, type AccountSession } from "@/lib/account-api";
import { sessionDevice } from "@/lib/session-device";

function SessionTime({ value }: { value: string }) {
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      )}
    </time>
  );
}

export function AccountSessions() {
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [target, setTarget] = useState<AccountSession | "others" | null>(null);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const result = await accountRequest<{ sessions: AccountSession[] }>("/api/account/sessions");
      if (request === sequence.current) setSessions(result.sessions);
    } catch (error) {
      if (request === sequence.current)
        setError(error instanceof Error ? error.message : "Unable to load sessions.");
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    const request = ++sequence.current;
    accountRequest<{ sessions: AccountSession[] }>("/api/account/sessions")
      .then((result) => {
        if (active && request === sequence.current) setSessions(result.sessions);
      })
      .catch((error: Error) => {
        if (active && request === sequence.current) setError(error.message);
      })
      .finally(() => {
        if (active && request === sequence.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function revoke() {
    if (!target || pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      if (target === "others") await accountRequest("/api/auth/revoke-other-sessions", {});
      else await accountRequest("/api/account/sessions/revoke", { id: target.id });
      setNotice(
        target === "others"
          ? "All other devices have been signed out."
          : "The device has been signed out.",
      );
      setTarget(null);
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to sign out this device.");
    } finally {
      setPending(false);
    }
  }
  const others = sessions?.filter((session) => !session.current).length ?? 0;
  const sorted = sessions
    ? [...sessions].sort(
        (a, b) =>
          Number(b.current) - Number(a.current) ||
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
    : [];
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Sessions"
        description="See where you’re signed in and manage access to your account."
        actions={
          <>
            <Button variant="outline" disabled={loading || pending} onClick={() => void load()}>
              <RotateCw className={loading ? "animate-spin" : ""} />
              Refresh
            </Button>
            <Button
              variant="outline"
              disabled={loading || pending || !others}
              onClick={() => {
                setError("");
                setTarget("others");
              }}
            >
              <LogOut />
              Sign out other devices
            </Button>
          </>
        }
      />
      {error && !target ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Unable to load or update sessions</AlertTitle>
          <AlertDescription>
            {error}
            <Button
              variant="ghost"
              className="ml-2"
              disabled={loading || pending}
              onClick={() => void load()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert role="status">
          <ShieldCheck />
          <AlertTitle>{notice}</AlertTitle>
          <AlertDescription>Your current device stays signed in.</AlertDescription>
        </Alert>
      ) : null}
      <Panel className="border p-0 sm:p-0" aria-busy={loading}>
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Monitor className="size-4 text-muted-foreground" />
            Active sessions
          </h2>
          <Badge variant="secondary">
            {sessions ? `${sessions.length} signed in` : loading ? "Loading" : "Unavailable"}
          </Badge>
        </div>
        {!sessions && loading ? (
          <div role="status" aria-label="Loading sessions" className="grid gap-6 p-5">
            {[0, 1, 2].map((key) => (
              <div key={key} className="flex gap-4">
                <Skeleton className="size-11 rounded-xl" />
                <div className="grid flex-1 gap-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-64 max-w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {sorted.map((session) => {
          const device = sessionDevice(session.userAgent);
          const DeviceIcon =
            device.kind === "phone" ? Smartphone : device.kind === "tablet" ? Tablet : Monitor;
          return (
            <article
              key={session.id}
              className="flex flex-col gap-4 border-b p-5 last:border-b-0 sm:flex-row sm:items-start"
            >
              <div
                className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${session.current ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
              >
                <DeviceIcon className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium">{device.label}</h3>
                  {session.current ? (
                    <Badge variant="secondary">
                      <ShieldCheck />
                      This device
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                  <p className="flex items-center gap-2">
                    <Globe2 className="size-3.5 shrink-0" />
                    <span>IP address: {session.ipAddress || "Unavailable"}</span>
                  </p>
                  <p className="flex items-center gap-2">
                    <Clock3 className="size-3.5 shrink-0" />
                    <span>
                      Last active: <SessionTime value={session.updatedAt} />
                    </span>
                  </p>
                  <p className="flex items-center gap-2">
                    <CalendarClock className="size-3.5 shrink-0" />
                    <span>
                      Signed in: <SessionTime value={session.createdAt} />
                    </span>
                  </p>
                  <p className="flex items-center gap-2">
                    <CalendarClock className="size-3.5 shrink-0" />
                    <span>
                      Expires: <SessionTime value={session.expiresAt} />
                    </span>
                  </p>
                </div>
              </div>
              {!session.current ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading || pending}
                  onClick={() => {
                    setError("");
                    setTarget(session);
                  }}
                >
                  <LogOut />
                  Sign out
                </Button>
              ) : null}
            </article>
          );
        })}
        {sessions && !sessions.length && !loading ? (
          <div className="flex flex-col items-center gap-2 px-5 py-12 text-center">
            <Monitor className="mb-2 size-8 text-muted-foreground" />
            <h3 className="text-sm font-medium">No active sessions</h3>
            <p className="text-sm text-muted-foreground">Refresh to check for new sessions.</p>
          </div>
        ) : null}
      </Panel>
      <Dialog
        open={!!target}
        onOpenChange={(open) => {
          if (!open && !pending) setTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {target === "others" ? "Sign out other devices?" : "Sign out this device?"}
            </DialogTitle>
            <DialogDescription>
              {target === "others"
                ? "All other active sessions will end. You’ll stay signed in on this device."
                : `${target ? sessionDevice(target.userAgent).label : "This device"} will need to sign in again to access your account.`}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive-solid" disabled={pending} onClick={() => void revoke()}>
              {pending ? <LoaderCircle className="animate-spin" /> : <LogOut />}Sign out
              {target === "others" ? " other devices" : " device"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
