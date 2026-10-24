"use client";

import { PanelMessage } from "@/ui/panel-message";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "./account-provider";
import { useNotifications } from "./notification-provider";
import { accountRequest, AccountApiError, errorMessage } from "@/lib/account-api";
import type { AccountSession } from "@/lib/auth-types";
import { accountTime, sessionDevice } from "@/lib/account-display";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { FormFeedback } from "@/ui/auth-fields";
import { Icon } from "@/ui/icon";
import { SettingsRow } from "@/ui/settings-row";
import { StatusPill } from "@/ui/status-pill";

export function AccountSessions() {
  const { expireSession } = useAccount();
  const { notify } = useNotifications();
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [target, setTarget] = useState<AccountSession | "others" | null>(null);
  const sequence = useRef(0);
  const lock = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    const current = ++sequence.current; setLoading(true); setError("");
    try {
      const result = await accountRequest<{ sessions: AccountSession[] }>("/api/account/sessions", undefined, signal);
      if (current === sequence.current) setSessions(result.sessions);
    } catch (error) {
      if (signal?.aborted || current !== sequence.current) return;
      if (error instanceof AccountApiError && error.status === 401) expireSession();
      setError(errorMessage(error));
    } finally { if (!signal?.aborted && current === sequence.current) setLoading(false); }
  }, [expireSession]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  const sorted = [...(sessions ?? [])].sort((a, b) => Number(b.current) - Number(a.current) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const others = sorted.filter(item => !item.current).length;
  const open = (session: AccountSession | "others") => { setDialogError(""); setTarget(session); };

  async function revoke() {
    if (!target || lock.current || (target !== "others" && target.current)) return;
    lock.current = true; setPending(true); setDialogError("");
    try {
      await accountRequest(target === "others" ? "/api/auth/revoke-other-sessions" : "/api/account/sessions/revoke", target === "others" ? {} : { id: target.id });
      notify(target === "others" ? "Other devices signed out" : "Device signed out"); setTarget(null); await load();
    } catch (error) { if (error instanceof AccountApiError && error.status === 401) expireSession(); setDialogError(errorMessage(error)); }
    finally { lock.current = false; setPending(false); }
  }

  return <section className="content account-security-content" aria-label="Sessions and devices">
    <Link href="/account" className="account-back"><Icon name="chevronLeft" size={15.75} />Account</Link>
    <div className="panel"><SettingsRow icon="device" label="Signed-in devices" value={sessions ? String(sessions.length) : loading ? "Loading…" : "Unavailable"} trailing={<></>} /></div>
    <FormFeedback error={error} />
    <section className="settings-section"><div className="account-section-heading"><h2>Active sessions</h2><button className="auth-text-button" disabled={loading || pending} onClick={() => void load()}>{loading ? "Refreshing…" : "Refresh"}</button></div>
      <div className="panel">{sorted.map(session => <button key={session.id} className="account-list-row" type="button" onClick={() => open(session)}>
        <span className={`account-list-icon ${session.current ? "account-list-icon-active" : ""}`}><Icon name="device" size={21.2625} /></span>
        <span className="account-list-copy"><span className="account-list-title">{sessionDevice(session.userAgent)}</span><span className="account-list-description">{session.ipAddress || "IP unavailable"} · {accountTime(session.updatedAt)}</span></span>
        {session.current ? <StatusPill active>This device</StatusPill> : <Icon name="chevronRight" className="row-chevron" size={17.325} />}
      </button>)}{!sorted.length && <PanelMessage className="account-panel-message" role="status">{loading ? "Loading your devices…" : error ? "Your sessions couldn’t be loaded." : "No active sessions found."}</PanelMessage>}</div>
      <p className="account-section-note">Select a device to see sign-in, activity, and expiry details.</p>
    </section>
    <Button className="account-section-action" icon="logout" disabled={!others || pending || loading} onClick={() => open("others")}>Sign out other devices</Button>
    <Dialog open={target !== null} title={target === "others" ? "Sign out other devices?" : "Session details"} dismissible={!pending} onClose={() => { if (!pending) setTarget(null); }}>
      <div className="form-stack"><FormFeedback error={dialogError} />{target === "others" ? <p className="account-note">End {others} other {others === 1 ? "session" : "sessions"}. This device will stay signed in.</p> : target && <>
        <div className="account-detail-heading"><Icon name="device" /><span>{sessionDevice(target.userAgent)}</span></div>
        <dl className="account-detail-list"><div><dt>IP address</dt><dd>{target.ipAddress || "Unavailable"}</dd></div><div><dt>Signed in</dt><dd>{accountTime(target.createdAt)}</dd></div><div><dt>Last active</dt><dd>{accountTime(target.updatedAt)}</dd></div><div><dt>Expires</dt><dd>{accountTime(target.expiresAt)}</dd></div></dl>
      </>}{target && (target === "others" || !target.current) ? <Button variant="danger" icon="logout" disabled={pending} onClick={() => void revoke()}>{pending ? "Signing out…" : target === "others" ? "Sign out other devices" : "Sign out this device"}</Button> : <p className="account-note">This is your current device. Use Logout in Account to sign out.</p>}</div>
    </Dialog>
  </section>;
}
