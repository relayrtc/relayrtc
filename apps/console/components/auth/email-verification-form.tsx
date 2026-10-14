"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle, LoaderCircle, Mail, RotateCw } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { VerificationCodeInput } from "@/components/auth/verification-code-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { accountRequest } from "@/lib/account-api";
import { readAuthQuery } from "@/lib/auth-query";

export function EmailVerificationForm() {
  const router = useRouter();
  const query = useSearchParams();
  const email = query.get("email") ?? "";
  const destination = readAuthQuery({
    redirect: query.get("redirect") ?? "/auth/continue",
  }).redirect;
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(60);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [policy, setPolicy] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    accountRequest<{ emailVerificationRequired: boolean }>("/api/account/verification-policy")
      .then((result) => {
        if (!active) return;
        if (!result.emailVerificationRequired) {
          router.replace(destination);
          router.refresh();
        } else setPolicy(true);
      })
      .catch((error: Error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [destination, router]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email || !/^\d{6}$/.test(code) || pending || resending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await accountRequest<{ twoFactorRedirect?: boolean }>(
        "/api/auth/email-otp/verify-email",
        { email, otp: code },
      );
      router.replace(
        result.twoFactorRedirect
          ? `/auth/two-factor?redirect=${encodeURIComponent(destination)}`
          : destination,
      );
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to verify this code.");
      setPending(false);
    }
  }
  async function resend() {
    if (!email || cooldown || pending || resending) return;
    setResending(true);
    setError("");
    setNotice("");
    try {
      await accountRequest("/api/auth/email-otp/send-verification-otp", {
        email,
        type: "email-verification",
      });
      setCode("");
      setCooldown(60);
      setNotice("A new verification code has been requested. Check your inbox.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to resend the code.");
    } finally {
      setResending(false);
    }
  }
  if (policy === null)
    return (
      <div className="w-full max-w-sm">
        <Logo className="mb-10" />
        <p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">
          {error || "Loading..."}
        </p>
        {error ? (
          <Link href="/auth/login" className="mt-4 block text-sm underline">
            Back to sign in
          </Link>
        ) : null}
      </div>
    );
  return (
    <div className="w-full max-w-sm">
      <Logo className="mb-10" />
      <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-muted">
        <Mail className="size-6 text-muted-foreground" />
      </div>
      <h1 className="text-3xl font-normal tracking-tight">Verify your email</h1>
      {email ? (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            Enter the six-digit code sent to{" "}
            <span className="break-all font-medium text-foreground">{email}</span>.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            The code expires in 5 minutes. Check your spam folder too.
          </p>
          <form onSubmit={confirm} className="mt-8 grid gap-5">
            {error ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {notice ? (
              <p role="status" className="text-sm text-muted-foreground">
                {notice}
              </p>
            ) : null}
            <div className="grid gap-3">
              <Label htmlFor="email-verification-code">Verification code</Label>
              <VerificationCodeInput
                id="email-verification-code"
                name="code"
                value={code}
                onChange={setCode}
                disabled={pending || resending}
                aria-invalid={!!error}
                required
                autoFocus
              />
            </div>
            <Button type="submit" size="lg" disabled={pending || resending || code.length !== 6}>
              {pending ? <LoaderCircle className="animate-spin" /> : null}
              {pending ? "Confirming..." : "Confirm"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending || resending || cooldown > 0}
              onClick={() => void resend()}
            >
              {resending ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
              {cooldown ? `Resend code in ${cooldown}s` : "Resend code"}
            </Button>
          </form>
        </>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          Sign in or create an account first. We’ll send a verification code to your email
          automatically.
        </p>
      )}
      <p className="mt-6 text-center text-sm text-muted-foreground">
        <Link href="/auth/login" className="underline underline-offset-4">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
