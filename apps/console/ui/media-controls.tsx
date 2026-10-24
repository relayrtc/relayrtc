"use client";

import { useEffect, useState } from "react";
import { useNotifications } from "@/components/notification-provider";
import { Button } from "./button";
import { Field, FormFeedback } from "./auth-fields";
import type { MediaGrant, StreamingOperation } from "@/lib/stream-types";
import { MediaPlayback } from "./media-playback";

export function MediaCopy({ value, label }: { value: string; label: string }) {
  const { notify } = useNotifications();
  const [error, setError] = useState("");
  return <div className="developer-dialog-stack"><Field label={label}><input className="input stream-code-input" value={value} readOnly autoComplete="off" spellCheck={false} /></Field><Button icon="copy" onClick={async () => { try { await navigator.clipboard.writeText(value); setError(""); notify(`${label} copied`); } catch { setError("Could not copy. Select and copy the value above."); } }}>Copy {label.toLowerCase()}</Button><FormFeedback error={error} /></div>;
}

export function MediaGrantLink({ grant, label = "Open media" }: { grant: MediaGrant; label?: string }) {
  const [now, setNow] = useState(Date.now());
  const [preview, setPreview] = useState(false);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  let url: URL | null = null;
  try { const parsed = new URL(grant.url); if (["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed; } catch { /* No arbitrary schemes from returned links. */ }
  const expired = !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now;
  if (!url) return <FormFeedback error="The API returned an invalid media URL." />;
  return <div className="developer-dialog-stack">{expired ? <FormFeedback notice="This link has expired. Generate a new link to continue." /> : <>{!url.pathname.endsWith("download.mp4") && <><Button onClick={() => setPreview(value => !value)}>{preview ? "Close preview" : "Preview media"}</Button>{preview && <MediaPlayback key={grant.url} grant={grant} />}</>}<MediaCopy value={url.href} label="Access URL" /><a className="button button-primary" href={url.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{label}</a><p className="account-note">Expires in {Math.max(0, Math.ceil((Date.parse(grant.expiresAt) - now) / 1000))} seconds. Keep this access link private.</p></>}</div>;
}

export function MediaOperationStatus({ operation }: { operation: StreamingOperation }) {
  return <FormFeedback error={operation.status === "failed" ? `The ${operation.kind} request failed${operation.errorCode ? ` (${operation.errorCode})` : ""}. Reload the stream before trying again.` : undefined} notice={operation.status === "pending" ? `The ${operation.kind} request is queued. Waiting for the streaming worker…` : operation.status === "completed" ? `The ${operation.kind} request completed.` : undefined} />;
}
