"use client";

import { Checkbox } from "@/ui/checkbox";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { accountRequest, AccountApiError, errorMessage } from "@/lib/account-api";
import { oauthRedirect } from "@/lib/auth-query";
import type { AuthResult } from "@/lib/auth-types";
import { clearAccountStorage } from "@/lib/storage";
import { useAccount } from "./account-provider";
import { useNotifications } from "./notification-provider";
import { Button } from "@/ui/button";
import { Field, CodeInput, PasswordInput, FormFeedback } from "@/ui/auth-fields";
import { Icon } from "@/ui/icon";

export type AccountDialog = "profile" | "email" | "verify-email" | "password" | "mfa" | "codes" | "delete" | "logout" | "google" | "github";
type Enrollment = { totpURI: string; backupCodes: string[] };

export const accountDialogTitles: Record<AccountDialog, string> = {
  profile: "Your profile", email: "Change email address", "verify-email": "Verify email address", password: "Manage password",
  mfa: "Two-factor authentication", codes: "Recovery codes", delete: "Delete account", logout: "Log out of Relayrtc?", google: "Google account", github: "GitHub account",
};

export function AccountDialogForm({ view, onDone, onBusy }: { view: AccountDialog; onDone: () => void; onBusy: (busy: boolean) => void }) {
  const { account, refreshAccount, signOut, endSession } = useAccount();
  const { notify } = useNotifications();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [emailStep, setEmailStep] = useState<"initial" | "current" | "new">("initial");
  const [newEmail, setNewEmail] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [savedCodes, setSavedCodes] = useState(false);
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const lock = useRef(false);
  const hasPassword = account.accounts.some(item => item.providerId === "credential");
  useEffect(() => { if (!cooldown) return; const timer = setTimeout(() => setCooldown(value => Math.max(0, value - 1)), 1000); return () => clearTimeout(timer); }, [cooldown]);

  async function run(task: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setPending(true); onBusy(true); setError(""); setNotice("");
    try { await task(); }
    catch (error) { setError(errorMessage(error)); if (error instanceof AccountApiError && error.retryAfter) setCooldown(error.retryAfter); }
    finally { lock.current = false; setPending(false); onBusy(false); }
  }
  async function done(message: string) { await refreshAccount(); notify(message); onDone(); }
  function submit(event: FormEvent<HTMLFormElement>, task: (data: FormData, form: HTMLFormElement) => Promise<void>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    void run(() => task(data, form));
  }
  const feedback = <FormFeedback error={error} notice={notice} />;
  const action = (text: string, disabled = false, danger = false) => <Button type="submit" variant={danger ? "danger" : "primary"} disabled={pending || disabled}>{pending ? "Please wait…" : text}</Button>;
  const currentPassword = hasPassword && <Field label="Current password"><PasswordInput name="password" placeholder="Current password" autoComplete="current-password" required /></Field>;
  const form = (children: ReactNode, task: (data: FormData, form: HTMLFormElement) => Promise<void>) => <form className="form-stack account-form" onSubmit={event => submit(event, task)}><fieldset disabled={pending}>{feedback}{children}</fieldset></form>;

  if (view === "profile") return form(<>
    <Field label="Name"><input className="input" name="name" defaultValue={account.user.name} autoComplete="name" minLength={1} maxLength={120} required /></Field>
    <Field label="Profile image URL"><input className="input" name="image" type="url" defaultValue={account.user.image ?? ""} placeholder="https://…" pattern="https://.*" /></Field>
    <p className="account-note">Use an HTTPS image URL, or leave it empty to use your initials.</p>{action("Save profile")}
  </>, async data => { const name = String(data.get("name")).trim(); if (!name) throw new Error("Enter your name."); await accountRequest("/api/auth/update-user", { name, image: String(data.get("image")).trim() || null }); await done("Profile updated"); });

  if (view === "password") return form(<>
    {hasPassword && <Field label="Current password"><PasswordInput name="currentPassword" autoComplete="current-password" required /></Field>}
    <Field label="New password"><PasswordInput name="newPassword" autoComplete="new-password" minLength={8} required /></Field>
    <Field label="Confirm new password"><PasswordInput name="confirmation" autoComplete="new-password" minLength={8} required /></Field>
    <p className="account-note">Use 8 to 128 characters. Changing your password signs out other devices.</p><Link href="/auth/forgot-password" className="auth-inline-link account-note">Forgot password?</Link>{action(hasPassword ? "Change password" : "Set password")}
  </>, async (data, target) => {
    if (data.get("newPassword") !== data.get("confirmation")) throw new Error("The passwords don’t match.");
    await accountRequest(hasPassword ? "/api/auth/change-password" : "/api/account/password", { newPassword: data.get("newPassword"), ...(hasPassword ? { currentPassword: data.get("currentPassword"), revokeOtherSessions: true } : {}) });
    target.reset(); await done("Password saved");
  });

  if (view === "email") return form(<>
    <p className="account-note">Verify both email addresses to make this change. Other devices will be signed out.</p>
    <Field label="Current email"><input className="input" value={account.user.email} readOnly /></Field>
    <Field label="New email address"><input className="input" type="email" value={newEmail} onChange={event => setNewEmail(event.target.value)} disabled={emailStep !== "initial"} autoComplete="email" maxLength={254} required /></Field>
    {emailStep !== "initial" && <Field label={emailStep === "current" ? "Code from your current email" : "Code from your new email"}><CodeInput key={emailStep} autoFocus /></Field>}
    {action(emailStep === "initial" ? cooldown ? `Try again in ${cooldown}s` : "Verify current email" : emailStep === "current" ? "Verify new email" : "Change email", emailStep === "initial" && cooldown > 0)}
    {emailStep !== "initial" && <button className="auth-text-button" type="button" onClick={() => { setEmailStep("initial"); setNotice(""); setError(""); }}>Start over</button>}
  </>, async (data, target) => {
    if (emailStep === "initial") {
      if (newEmail.trim().toLowerCase() === account.user.email.toLowerCase()) throw new Error("Choose a different email address.");
      await accountRequest("/api/auth/email-otp/send-verification-otp", { email: account.user.email, type: "email-verification" });
      setEmailStep("current"); setCooldown(60); setNotice("Enter the code sent to your current email. It expires in 5 minutes.");
    } else if (emailStep === "current") {
      await accountRequest("/api/auth/email-otp/request-email-change", { newEmail: newEmail.trim(), otp: data.get("code") });
      setEmailStep("new"); setNotice("Enter the code sent to your new email. If it’s already in use, choose another address.");
    } else {
      await accountRequest("/api/auth/email-otp/change-email", { newEmail: newEmail.trim(), otp: data.get("code") });
      target.reset(); await done("Email address changed");
    }
  });

  if (view === "verify-email") return form(<>
    <p className="account-note">Verify {account.user.email} with a six-digit code. Codes expire in 5 minutes.</p>
    <Button type="button" disabled={pending || cooldown > 0} onClick={() => void run(async () => {
      await accountRequest("/api/auth/email-otp/send-verification-otp", { email: account.user.email, type: "email-verification" });
      setCooldown(60); setNotice("A verification code has been requested. Check your inbox.");
    })}>{cooldown ? `Resend in ${cooldown}s` : "Send verification code"}</Button>
    <Field label="Verification code"><CodeInput /></Field>{action("Verify email")}
  </>, async data => {
    const result = await accountRequest<AuthResult>("/api/auth/email-otp/verify-email", { email: account.user.email, otp: data.get("code") });
    if (result.twoFactorRedirect) { window.location.assign("/auth/two-factor?redirect=%2Faccount"); return; }
    await done("Email verified");
  });

  if (view === "mfa" || view === "codes") {
    if (codes.length) return <div className="form-stack">{feedback}<p className="account-note">Save these codes somewhere safe. Each one can be used once to sign in without your authenticator.</p><div className="recovery-codes">{codes.map(code => <code key={code}>{code}</code>)}</div><div className="account-button-pair"><Button type="button" icon="copy" onClick={() => void run(async () => { await navigator.clipboard.writeText(codes.join("\n")); notify("Recovery codes copied"); })}>Copy</Button><Button type="button" icon="download" onClick={() => {
      const blob = new Blob([`Relayrtc recovery codes\n${codes.join("\n")}\n\nKeep these private. Each code can be used once.\n`], { type: "text/plain" });
      const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "relayrtc-recovery-codes.txt"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}>Download</Button></div><label className="account-checkbox"><Checkbox type="checkbox" checked={savedCodes} onChange={event => setSavedCodes(event.target.checked)} />I’ve saved my recovery codes.</label><Button variant="primary" disabled={!savedCodes || pending} onClick={() => { setCodes([]); notify("Recovery codes saved"); onDone(); }}>Done</Button></div>;

    if (enrollment) {
      const secret = new URL(enrollment.totpURI).searchParams.get("secret") ?? "";
      return form(<>
        <p className="account-note">In your authenticator app, add a time-based account using this setup key, then enter its six-digit code.</p>
        <div className="setup-secret"><code>{secret}</code><button type="button" className="icon-button" aria-label="Copy authenticator setup key" onClick={() => void run(async () => { await navigator.clipboard.writeText(secret); notify("Setup key copied"); })}><Icon name="copy" size={17.325} /></button></div>
        <a className="auth-inline-link account-note" href={enrollment.totpURI}>Open in authenticator app</a>
        <Field label="Authenticator code"><CodeInput autoFocus /></Field>{action("Confirm authenticator")}
      </>, async data => {
        await accountRequest("/api/auth/two-factor/verify-totp", { code: data.get("code"), trustDevice: false });
        setCodes(enrollment.backupCodes); setEnrollment(null); await refreshAccount(); notify("Two-factor authentication enabled");
      });
    }

    const disabling = view === "mfa" && account.user.twoFactorEnabled;
    return form(<>
      <div className="feature-symbol"><Icon name="shield" size={26.775} /></div>
      <p className="account-note">{view === "codes" ? "Generate a new set of recovery codes. All previous recovery codes will stop working." : disabling ? "Your authenticator will no longer be required at sign-in. Other devices will be signed out." : "Protect your account with an authenticator app and recovery codes."}</p>
      {currentPassword}{action(view === "codes" ? "Generate new codes" : disabling ? "Disable authenticator" : "Set up authenticator", false, disabling)}
    </>, async (data, target) => {
      const body = hasPassword ? { password: data.get("password") } : {};
      if (view === "codes") { const result = await accountRequest<{ backupCodes: string[] }>("/api/auth/two-factor/generate-backup-codes", body); setCodes(result.backupCodes); setSavedCodes(false); notify("New recovery codes generated"); }
      else if (disabling) { await accountRequest("/api/auth/two-factor/disable", body); await done("Authenticator disabled"); }
      else {
        const result = await accountRequest<Enrollment>("/api/auth/two-factor/enable", body);
        const uri = new URL(result.totpURI); if (uri.protocol !== "otpauth:" || !uri.searchParams.get("secret") || !Array.isArray(result.backupCodes)) throw new Error("Unable to begin authenticator setup. Please try again.");
        setEnrollment(result);
      }
      target.reset();
    });
  }

  if (view === "google" || view === "github") {
    const linked = account.accounts.find(item => item.providerId === view);
    const name = view === "google" ? "Google" : "GitHub";
    const lastMethod = Boolean(linked && account.accounts.length <= 1);
    return form(<>
      <p className="account-note">{linked ? `${name} is connected to your Relayrtc account.` : `Connect ${name} to use it as a sign-in method.`}</p>
      {lastMethod && <p className="account-note">Add a password or another provider before disconnecting your only sign-in method.</p>}
      {action(linked ? `Disconnect ${name}` : `Connect ${name}`, lastMethod, Boolean(linked))}
    </>, async () => {
      if (linked) { await accountRequest("/api/auth/unlink-account", { providerId: linked.providerId, accountId: linked.accountId }); await done(`${name} disconnected`); }
      else {
        const result = await accountRequest<AuthResult>("/api/auth/link-social", { provider: view, callbackURL: new URL("/account", window.location.origin).href });
        if (!result.url) throw new Error("The provider did not return a redirect. Please try again.");
        window.location.assign(oauthRedirect(result.url));
      }
    });
  }

  if (view === "delete") {
    const ownsOrganization = account.ownedOrganizations.length > 0;
    return form(<>
      <p className="account-note">Permanently delete your personal account, credentials, and active sessions. This cannot be undone.</p>
      {ownsOrganization ? <p className="form-feedback" role="status">Transfer ownership or delete your organizations first: {account.ownedOrganizations.map(item => item.name).join(", ")}.</p> : <>
        <Field label="Confirm your email address"><input type="email" className="input" value={confirmationEmail} onChange={event => setConfirmationEmail(event.target.value)} placeholder={account.user.email} autoComplete="email" required /></Field>{currentPassword}
        <label className="account-checkbox"><Checkbox type="checkbox" checked={deleteAcknowledged} onChange={event => setDeleteAcknowledged(event.target.checked)} required />I understand this permanently deletes my account.</label>
      </>}{action("Delete account permanently", ownsOrganization || !deleteAcknowledged || confirmationEmail.trim().toLowerCase() !== account.user.email.toLowerCase(), true)}
    </>, async data => {
      if (ownsOrganization || !deleteAcknowledged) return;
      await accountRequest("/api/account/delete", { confirmationEmail: confirmationEmail.trim(), ...(hasPassword ? { password: data.get("password") } : {}) });
      clearAccountStorage(account.user.id);
      endSession();
    });
  }

  return <div className="form-stack">{feedback}<p className="account-note">You’ll be signed out on this device.</p><Button variant="primary" icon="logout" disabled={pending} onClick={() => void run(signOut)}>{pending ? "Logging out…" : "Logout"}</Button><Button disabled={pending} onClick={onDone}>Cancel</Button></div>;
}
