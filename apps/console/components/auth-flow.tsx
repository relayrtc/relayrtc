"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { accountRequest, AccountApiError, errorMessage } from "@/lib/account-api";
import { authHref, authSearchParams, oauthRedirect, postAuthDestination } from "@/lib/auth-query";
import type { AuthResult } from "@/lib/auth-types";
import { AuthFrame } from "@/ui/auth-frame";
import { CodeInput, Field, FormFeedback, PasswordInput } from "@/ui/auth-fields";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { ProviderIcon } from "@/ui/provider-icon";

export type AuthMode = "login" | "signup" | "verify-email" | "forgot-password" | "reset-password" | "two-factor";
export type AuthParams = Record<string, string | string[] | undefined>;

export function AuthFlow({ mode, params = {} }: { mode: AuthMode; params?: AuthParams }) {
  const query = authSearchParams(params);
  const destination = postAuthDestination(query);
  const router = useRouter();
  const [email, setEmail] = useState(query.get("email") ?? "");
  const [passwordStep, setPasswordStep] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState(false);
  const [resetByCode, setResetByCode] = useState(mode === "reset-password" && !query.get("token"));
  const [sent, setSent] = useState(false);
  const [finished, setFinished] = useState(false);
  const [pending, setPending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState(query.get("error") ? "Sign-in could not be completed. Please try again." : "");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const token = query.get("token");
  const href = (path: string, extras?: Record<string, string>) => authHref(path, destination, extras);

  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function run(task: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(""); setNotice("");
    try { await task(); }
    catch (error) {
      if (error instanceof AccountApiError && error.retryAfter) setCooldown(error.retryAfter);
      setError(errorMessage(error));
    } finally { lock.current = false; setPending(false); }
  }

  function complete(result?: AuthResult) {
    if (result?.twoFactorRedirect) { router.replace(href("/auth/two-factor")); return; }
    // A full navigation drops the previous user's client tree and rechecks the
    // real HTTP-only session in the protected server layout.
    window.location.assign(destination);
  }

  async function social(provider: "google" | "github") {
    await run(async () => {
      const result = await accountRequest<AuthResult>("/api/auth/sign-in/social", {
        provider, callbackURL: new URL(destination, window.location.origin).href,
        errorCallbackURL: new URL(href("/auth/login", { error: "oauth" }), window.location.origin).href,
      });
      if (!result.url) throw new Error("The sign-in provider did not return a redirect. Please try again.");
      window.location.assign(oauthRedirect(result.url));
    });
  }

  function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!passwordStep) { setEmail(email.trim()); setPasswordStep(true); setError(""); return; }
    const data = new FormData(event.currentTarget);
    void run(async () => {
      try {
        complete(await accountRequest<AuthResult>("/api/auth/sign-in/email", { email: email.trim(), password: data.get("password") }));
      } catch (error) {
        if (error instanceof AccountApiError && error.code === "EMAIL_NOT_VERIFIED") { router.replace(href("/auth/verify-email", { email: email.trim() })); return; }
        throw error;
      }
    });
  }

  function signUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (data.get("password") !== data.get("confirmation")) { setError("The passwords don’t match."); return; }
    if (!String(data.get("name")).trim()) { setError("Enter your name."); return; }
    void run(async () => {
      const result = await accountRequest<AuthResult>("/api/auth/sign-up/email", { name: String(data.get("name")).trim(), email: email.trim(), password: data.get("password") });
      if (result.token) complete(result);
      else router.replace(href("/auth/verify-email", { email: email.trim() }));
    });
  }

  function sendVerification() {
    void run(async () => {
      await accountRequest("/api/auth/email-otp/send-verification-otp", { email: email.trim(), type: "email-verification" });
      setSent(true); setCooldown(60); setNotice("A verification code has been requested. Check your inbox and spam folder.");
    });
  }

  function confirmEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    void run(async () => complete(await accountRequest<AuthResult>("/api/auth/email-otp/verify-email", { email: email.trim(), otp: data.get("code") })));
  }

  function requestReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      if (resetByCode) await accountRequest("/api/auth/email-otp/request-password-reset", { email: email.trim() });
      else await accountRequest("/api/auth/request-password-reset", { email: email.trim(), redirectTo: new URL(href("/auth/reset-password"), window.location.origin).href });
      setSent(true); setCooldown(60);
      setNotice(`If an account exists for this email, we’ve sent ${resetByCode ? "a reset code" : "a password reset link"}.`);
    });
  }

  function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); const form = event.currentTarget;
    if (data.get("password") !== data.get("confirmation")) { setError("The passwords don’t match."); return; }
    void run(async () => {
      if (token) await accountRequest("/api/auth/reset-password", { token, newPassword: data.get("password") });
      else await accountRequest("/api/auth/email-otp/reset-password", { email: email.trim(), otp: data.get("code"), password: data.get("password") });
      form.reset(); setFinished(true); setNotice("Your password has been reset. Sign in with your new password.");
      if (token) window.history.replaceState(null, "", href("/auth/reset-password"));
    });
  }

  function verifyMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    void run(async () => complete(await accountRequest<AuthResult>(recoveryCode ? "/api/auth/two-factor/verify-backup-code" : "/api/auth/two-factor/verify-totp", { code: String(data.get("code")).trim(), trustDevice: false })));
  }

  const providers = <><div className="login-divider" role="separator" aria-label="Or continue with"><span>or</span></div><div className="login-providers" aria-label="Other sign-in options">{(["google", "github"] as const).map(provider => <Button key={provider} type="button" className="login-provider-button" onClick={() => void social(provider)} disabled={pending}><ProviderIcon provider={provider} /><span>Continue with {provider === "google" ? "Google" : "GitHub"}</span></Button>)}</div></>;
  const feedback = <FormFeedback error={error} notice={notice} />;
  const back = <Link className="auth-text-button auth-back" href={href("/auth/login")}><Icon name="chevronLeft" size={14.175} />Back to login</Link>;
  const submit = (label: string) => <Button type="submit" variant="primary" className="onboarding-continue" disabled={pending}>{pending ? "Please wait…" : label}</Button>;

  if (mode === "login") return <AuthFrame title="Welcome to Relayrtc" description={passwordStep ? "Enter your password to continue." : "Log in or sign up to get started."}>
    <form className="login-form auth-form" onSubmit={signIn}>
      <fieldset disabled={pending}>
        <div className="login-input-wrap"><input className="input login-input" name="email" type="email" aria-label="Email Address" placeholder="Email Address" value={email} onChange={event => setEmail(event.target.value)} readOnly={passwordStep} autoComplete="email" autoFocus spellCheck={false} required maxLength={254} />{!passwordStep && email.trim() && <button className="login-submit" type="submit" aria-label="Continue with email"><Icon name="chevronRight" size={20.96325} /></button>}</div>
        {passwordStep && <><PasswordInput key="login-password" className="login-input" name="password" aria-label="Password" placeholder="Password" autoComplete="current-password" autoFocus required /><div className="auth-form-links"><button type="button" onClick={() => { setPasswordStep(false); setError(""); }}>Change email</button><Link href={href("/auth/forgot-password", { email })}>Forgot password?</Link></div></>}
        {feedback}{passwordStep && submit("Log in")}
      </fieldset>
    </form>
    {providers}<p className="login-helper">New to Relayrtc? <Link className="auth-inline-link" href={href("/auth/signup", { email })}>Create an account</Link></p>
  </AuthFrame>;

  if (mode === "signup") return <AuthFrame title="Create your Relayrtc account" description="Start building real-time experiences.">
    <form className="login-form auth-form" onSubmit={signUp}><fieldset disabled={pending}>
      <Field label="Name"><input name="name" className="input login-input auth-input" placeholder="Your name" autoComplete="name" autoFocus minLength={1} maxLength={120} required /></Field>
      <Field label="Email Address"><input name="email" className="input login-input auth-input" type="email" placeholder="Email Address" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" maxLength={254} required /></Field>
      <Field label="Password"><PasswordInput name="password" className="login-input" placeholder="Password" autoComplete="new-password" minLength={8} required /></Field>
      <Field label="Confirm password"><PasswordInput name="confirmation" className="login-input" placeholder="Confirm password" autoComplete="new-password" minLength={8} required /></Field>
      <p className="auth-hint">Use a unique password with 8 to 128 characters.</p>{feedback}{submit("Create account")}
    </fieldset></form>{providers}<p className="login-helper">Already have an account? <Link className="auth-inline-link" href={href("/auth/login", { email })}>Log in</Link></p>
  </AuthFrame>;

  if (mode === "verify-email") return <AuthFrame title="Verify your email" description="Enter the six-digit code from your inbox.">
    <form className="login-form auth-form" onSubmit={confirmEmail}><fieldset disabled={pending}>
      <Field label="Email Address"><input className="input login-input auth-input" name="email" type="email" value={email} onChange={event => { setEmail(event.target.value); setSent(false); }} placeholder="Email Address" autoComplete="email" required maxLength={254} /></Field>
      <Field label="Verification code"><CodeInput className="login-input" autoFocus /></Field>
      <p className="auth-hint">Codes expire after 5 minutes.</p>{feedback}{submit("Verify email")}
      <button type="button" className="auth-text-button" onClick={sendVerification} disabled={!email.trim() || cooldown > 0}>{cooldown ? `Resend in ${cooldown}s` : sent ? "Resend code" : "Send a verification code"}</button>
    </fieldset></form>{back}
  </AuthFrame>;

  if (mode === "two-factor") return <AuthFrame title={recoveryCode ? "Use a recovery code" : "Two-factor authentication"} description={recoveryCode ? "Enter one of your saved recovery codes." : "Enter the six-digit code from your authenticator."}>
    <form className="login-form auth-form" onSubmit={verifyMfa}><fieldset disabled={pending}><Field label={recoveryCode ? "Recovery code" : "Authenticator code"}><CodeInput key={String(recoveryCode)} className="login-input" recovery={recoveryCode} autoFocus /></Field>{feedback}{submit("Verify and continue")}<button className="auth-text-button" type="button" onClick={() => { setRecoveryCode(value => !value); setError(""); }}>{recoveryCode ? "Use authenticator instead" : "Use a recovery code"}</button></fieldset></form>{back}
  </AuthFrame>;

  if (mode === "forgot-password") return <AuthFrame title="Forgot your password?" description="We’ll help you get back into your account.">
    <form className="login-form auth-form" onSubmit={requestReset}><fieldset disabled={pending}>
      <Field label="Email Address"><input className="input login-input auth-input" name="email" type="email" value={email} onChange={event => { setEmail(event.target.value); setSent(false); }} placeholder="Email Address" autoComplete="email" autoFocus required maxLength={254} /></Field>
      <div className="segmented auth-segmented" role="group" aria-label="Recovery method"><button type="button" className={!resetByCode ? "segment-active" : ""} aria-pressed={!resetByCode} onClick={() => { setResetByCode(false); setSent(false); setNotice(""); }}>Email link</button><button type="button" className={resetByCode ? "segment-active" : ""} aria-pressed={resetByCode} onClick={() => { setResetByCode(true); setSent(false); setNotice(""); }}>Email code</button></div>
      {feedback}<Button type="submit" variant="primary" className="onboarding-continue" disabled={pending || cooldown > 0}>{pending ? "Sending…" : cooldown ? `Resend in ${cooldown}s` : resetByCode ? "Send reset code" : "Send reset link"}</Button>
      {sent && resetByCode && <Link className="auth-text-button" href={href("/auth/reset-password", { email })}>I have a reset code<Icon name="chevronRight" size={14.175} /></Link>}
    </fieldset></form>{back}
  </AuthFrame>;

  if (query.has("error") && !token && !finished) return <AuthFrame title="This reset link has expired" description="Request a new link to reset your password."><div className="login-form auth-form"><Link href={href("/auth/forgot-password")} className="button button-primary onboarding-continue">Request a new link</Link></div>{back}</AuthFrame>;

  return <AuthFrame title={finished ? "Password updated" : "Reset your password"} description={finished ? "You’re ready to sign in again." : "Choose a new password for your Relayrtc account."}>
    {finished ? <div className="login-form auth-form">{feedback}<Link className="button button-primary onboarding-continue" href={href("/auth/login", { email })}>Back to login</Link></div> : <form className="login-form auth-form" onSubmit={resetPassword}><fieldset disabled={pending}>
      {!token && <><Field label="Email Address"><input type="email" className="input login-input auth-input" placeholder="Email Address" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" required maxLength={254} /></Field><Field label="Reset code"><CodeInput className="login-input" autoFocus /></Field></>}
      <Field label="New password"><PasswordInput name="password" className="login-input" placeholder="New password" autoComplete="new-password" minLength={8} autoFocus={Boolean(token)} required /></Field>
      <Field label="Confirm new password"><PasswordInput name="confirmation" className="login-input" placeholder="Confirm new password" autoComplete="new-password" minLength={8} required /></Field><p className="auth-hint">Use a unique password with 8 to 128 characters.</p>
      {feedback}{submit("Reset password")}<Link className="auth-text-button" href={href("/auth/forgot-password", { email })}>Request a new reset link or code</Link>
    </fieldset></form>}{!finished && back}
  </AuthFrame>;
}
