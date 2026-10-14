"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { SectionHeading, SettingList, SettingRow } from "@/components/page/setting-row";
import { CopyButton } from "@/components/page/copy-button";
import { VerificationCodeInput } from "@/components/auth/verification-code-input";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { accountRequest, type AccountOverview } from "@/lib/account-api";

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
function Code({ id }: { id: string }) { return <VerificationCodeInput id={id} name="code" required />; }
const fields = (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  return new FormData(event.currentTarget);
};

export function AccountSecurity({
  account,
  onChange,
}: {
  account: AccountOverview;
  onChange: () => Promise<void>;
}) {
  const router = useRouter();
  const [modal, setModal] = useState<
    "email" | "verify-email" | "password" | "mfa" | "backup" | "delete" | null
  >(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    label: string;
    key: string;
    action: () => Promise<void>;
  } | null>(null);
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [emailStep, setEmailStep] = useState<"initial" | "current" | "new">("initial");
  const [newEmail, setNewEmail] = useState("");
  const [verifySent, setVerifySent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [enrollment, setEnrollment] = useState<{ totpURI: string; backupCodes: string[] } | null>(
    null,
  );
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const hasPassword = account.accounts.some((item) => item.providerId === "credential");
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  async function run(key: string, action: () => Promise<void>, message?: string) {
    if (busy) return;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await action();
      if (message) setNotice(message);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to complete this request.");
    } finally {
      setBusy("");
    }
  }
  const closeModal = (open: boolean) => {
    if (!open && !busy) {
      setModal(null);
      setBackupCodes([]);
    }
  };
  const cancel = (
    <Button type="button" variant="ghost" disabled={!!busy} onClick={() => closeModal(false)}>
      Cancel
    </Button>
  );
  const button = (key: string, text: string, extraDisabled = false) => (
    <DialogFooter>
      {cancel}
      <Button type="submit" disabled={!!busy || extraDisabled}>
        {busy === key ? <LoaderCircle className="animate-spin" /> : null}
        {text}
      </Button>
    </DialogFooter>
  );
  const feedback = (
    <>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </>
  );
  const openModal = (next: typeof modal) => {
    setError("");
    setNotice("");
    setModal(next);
  };
  const notifyChanged = async () => {
    await onChange();
  };
  async function link(provider: "google" | "github") {
    await run(`link-${provider}`, async () => {
      const result = await accountRequest<{ url: string }>("/api/auth/link-social", {
        provider,
        callbackURL: window.location.href,
      });
      if (!result.url || !result.url.startsWith("https://"))
        throw new Error("Unable to open the identity provider.");
      window.location.assign(result.url);
    });
  }
  const confirmationDialog = (
    <Dialog
      open={!!confirmation}
      onOpenChange={(open) => {
        if (!open && !busy) setConfirmation(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{confirmation?.title}</DialogTitle>
          <DialogDescription>{confirmation?.description}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" disabled={!!busy} onClick={() => setConfirmation(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive-solid"
            disabled={!!busy}
            onClick={() => {
              if (confirmation)
                void run(
                  confirmation.key,
                  async () => {
                    await confirmation.action();
                    setConfirmation(null);
                  },
                  "Account updated.",
                );
            }}
          >
            {busy ? <LoaderCircle className="animate-spin" /> : null}
            {confirmation?.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return (
    <>
      {!modal && !confirmation ? feedback : null}
      <section aria-label="Email security">
        <SectionHeading>Email address</SectionHeading>
        <SettingList>
          <SettingRow label="Email address">
            <div className="flex flex-wrap items-center gap-3">
              <span>{account.user.email}</span>
              <span className="text-xs text-muted-foreground">
                {account.user.emailVerified ? "Verified" : "Unverified"}
              </span>
              {!account.user.emailVerified && account.emailVerificationRequired ? (
                <Button
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => openModal("verify-email")}
                >
                  Verify email
                </Button>
              ) : null}
              <Button variant="outline" disabled={!!busy} onClick={() => openModal("email")}>
                Change email
              </Button>
            </div>
          </SettingRow>
        </SettingList>
      </section>
      <section aria-label="Password">
        <SectionHeading>Password</SectionHeading>
        <SettingList>
          <SettingRow label={hasPassword ? "Password login enabled" : "No password set"}>
            <Button variant="outline" disabled={!!busy} onClick={() => openModal("password")}>
              {hasPassword ? "Change password" : "Set password"}
            </Button>
          </SettingRow>
        </SettingList>
      </section>
      <section aria-label="Connected accounts">
        <SectionHeading>Connected accounts</SectionHeading>
        <p className="mb-4 text-sm text-muted-foreground">
          Manage your sign-in providers. Keep at least one login method connected.
        </p>
        <SettingList>
          {(["google", "github"] as const).map((provider) => {
            const connected = account.accounts.find((item) => item.providerId === provider);
            return (
              <SettingRow key={provider} label={provider === "google" ? "Google" : "GitHub"}>
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground">
                    {connected ? "Connected" : "Not connected"}
                  </span>
                  {connected ? (
                    <Button
                      variant="outline"
                      disabled={!!busy || account.accounts.length < 2}
                      onClick={() => {
                        setError("");
                        setConfirmation({
                          title: `Disconnect ${provider === "google" ? "Google" : "GitHub"}?`,
                          description:
                            "You will no longer be able to sign in with this provider. Your other login methods will stay connected.",
                          label: "Disconnect",
                          key: `unlink-${provider}`,
                          action: async () => {
                            await accountRequest("/api/auth/unlink-account", {
                              providerId: provider,
                              accountId: connected.accountId,
                            });
                            await onChange();
                          },
                        });
                      }}
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <Button variant="outline" disabled={!!busy} onClick={() => void link(provider)}>
                      Connect
                    </Button>
                  )}
                </div>
              </SettingRow>
            );
          })}
        </SettingList>
      </section>
      <section aria-label="Two-factor authentication">
        <SectionHeading>Two-factor authentication</SectionHeading>
        <SettingList>
          <SettingRow
            label={
              <span className="inline-flex items-center gap-2">
                <ShieldCheck className="size-4" />
                Authenticator
              </span>
            }
          >
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground">
                {account.user.twoFactorEnabled ? "Enabled" : "Not enabled"}
              </span>
              <Button variant="outline" disabled={!!busy} onClick={() => openModal("mfa")}>
                {enrollment
                  ? "Continue setup"
                  : account.user.twoFactorEnabled
                    ? "Disable"
                    : "Set up"}
              </Button>
            </div>
          </SettingRow>
          {account.user.twoFactorEnabled ? (
            <SettingRow label="Recovery codes">
              <Button variant="outline" disabled={!!busy} onClick={() => openModal("backup")}>
                Regenerate codes
              </Button>
            </SettingRow>
          ) : null}
        </SettingList>
      </section>
      <section aria-label="Sessions">
        <SectionHeading>Sessions and devices</SectionHeading>
        <SettingList>
          <SettingRow label="Manage where you?re signed in">
            <Button nativeButton={false} variant="outline" render={<Link href="?tab=profile-sessions" />}>
              Manage sessions
            </Button>
          </SettingRow>
        </SettingList>
      </section>
      <section aria-label="Delete account">
        <SectionHeading>Delete account</SectionHeading>
        <p className="mb-4 text-sm text-muted-foreground">
          Permanently delete your personal account and its sign-in methods.
        </p>
        <Button
          variant="destructive"
          disabled={!!busy}
          onClick={() => {
            setDeleteAcknowledged(false);
            openModal("delete");
          }}
        >
          Delete account
        </Button>
      </section>
      <Dialog open={modal === "email" || modal === "verify-email"} onOpenChange={closeModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {modal === "verify-email" ? "Verify email address" : "Change email address"}
            </DialogTitle>
            <DialogDescription>
              {modal === "verify-email"
                ? "Enter the verification code sent to your inbox."
                : "Verify your current and new email addresses. Other devices will be signed out after the change."}
            </DialogDescription>
          </DialogHeader>
          {feedback}
          {modal === "verify-email" ? (
            <div className="grid gap-4">
              <p className="text-sm text-muted-foreground">
                Verify your email address to secure your account.
              </p>
              <Button
                variant="outline"
                disabled={!!busy || cooldown > 0}
                onClick={() =>
                  void run(
                    "verify-send",
                    async () => {
                      await accountRequest("/api/auth/email-otp/send-verification-otp", {
                        email: account.user.email,
                        type: "email-verification",
                      });
                      setVerifySent(true);
                      setCooldown(60);
                    },
                    "A verification code has been requested. Check your inbox.",
                  )
                }
              >
                {cooldown ? `Resend in ${cooldown}s` : "Send verification code"}
              </Button>
              {!verifySent ? <DialogFooter>{cancel}</DialogFooter> : null}
              {verifySent ? (
                <form
                  className="grid gap-4"
                  onSubmit={(event) => {
                    const data = fields(event);
                    void run(
                      "verify-email",
                      async () => {
                        await accountRequest("/api/auth/email-otp/verify-email", {
                          email: account.user.email,
                          otp: data.get("code"),
                        });
                        setVerifySent(false);
                        await onChange();
                        setModal(null);
                      },
                      "Email verified.",
                    );
                  }}
                >
                  <Field label="Verification code" id="verify-email-code">
                    <Code id="verify-email-code" />
                  </Field>
                  {button("verify-email", "Verify email")}
                </form>
              ) : null}
            </div>
          ) : null}
          {modal === "email" ? (
            <>
              <form
                className="grid gap-4"
                onSubmit={(event) => {
                  const data = fields(event);
                  if (emailStep === "initial")
                    void run(
                      "email-current",
                      async () => {
                        await accountRequest("/api/auth/email-otp/send-verification-otp", {
                          email: account.user.email,
                          type: "email-verification",
                        });
                        setEmailStep("current");
                        setCooldown(60);
                      },
                      "Enter the code sent to your current email.",
                    );
                  else if (emailStep === "current")
                    void run(
                      "email-new",
                      async () => {
                        await accountRequest("/api/auth/email-otp/request-email-change", {
                          newEmail,
                          otp: data.get("code"),
                        });
                        setEmailStep("new");
                        setCooldown(60);
                      },
                      "Enter the code sent to your new email. If the address is already in use, choose another address.",
                    );
                  else
                    void run(
                      "email-change",
                      async () => {
                        await accountRequest("/api/auth/email-otp/change-email", {
                          newEmail,
                          otp: data.get("code"),
                        });
                        setEmailStep("initial");
                        setNewEmail("");
                        await notifyChanged();
                        setModal(null);
                      },
                      "Email address changed.",
                    );
                }}
              >
                <Field label="New email address" id="new-email">
                  <Input
                    id="new-email"
                    name="newEmail"
                    type="email"
                    autoComplete="email"
                    value={newEmail}
                    onChange={(event) => setNewEmail(event.target.value)}
                    disabled={emailStep !== "initial"}
                    required
                  />
                </Field>
                {emailStep !== "initial" ? (
                  <Field
                    label={
                      emailStep === "current" ? "Code from current email" : "Code from new email"
                    }
                    id="change-email-code"
                  >
                    <Code key={emailStep} id="change-email-code" />
                  </Field>
                ) : null}
                {emailStep !== "initial" ? (
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={!!busy}
                    onClick={() => setEmailStep("initial")}
                  >
                    Start over
                  </Button>
                ) : null}
                {button(
                  emailStep === "initial"
                    ? "email-current"
                    : emailStep === "current"
                      ? "email-new"
                      : "email-change",
                  emailStep === "initial"
                    ? "Verify current address"
                    : emailStep === "current"
                      ? "Verify new address"
                      : "Change email",
                  emailStep === "initial" && cooldown > 0,
                )}
              </form>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={modal === "password"} onOpenChange={closeModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{hasPassword ? "Change password" : "Set a password"}</DialogTitle>
            <DialogDescription>
              Use a unique password. Changing an existing password signs out other devices.
            </DialogDescription>
          </DialogHeader>
          {feedback}
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              const data = fields(event);
              const form = event.currentTarget;
              if (data.get("newPassword") !== data.get("confirmation")) {
                setError("The new passwords do not match.");
                return;
              }
              void run(
                "password",
                async () => {
                  await accountRequest(
                    hasPassword ? "/api/auth/change-password" : "/api/account/password",
                    {
                      newPassword: data.get("newPassword"),
                      ...(hasPassword
                        ? {
                            currentPassword: data.get("currentPassword"),
                            revokeOtherSessions: true,
                          }
                        : {}),
                    },
                  );
                  form.reset();
                  await notifyChanged();
                  setModal(null);
                },
                "Password saved.",
              );
            }}
          >
            {hasPassword ? (
              <Field label="Current password" id="current-password">
                <PasswordInput
                  id="current-password"
                  name="currentPassword"
                  autoComplete="current-password"
                  maxLength={128}
                  required
                />
              </Field>
            ) : null}
            <Field label="New password" id="new-password">
              <PasswordInput
                id="new-password"
                name="newPassword"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                required
              />
            </Field>
            <Field label="Confirm new password" id="confirm-password">
              <PasswordInput
                id="confirm-password"
                name="confirmation"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                required
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              Use a unique password with 8 to 128 characters. Changing an existing password signs
              out other devices.
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              <Link href="/auth/forgot-password" className="underline underline-offset-4">
                Forgot your password?
              </Link>
            </p>
            {button("password", hasPassword ? "Change password" : "Set password")}
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={modal === "mfa" || modal === "backup"} onOpenChange={closeModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {backupCodes.length
                ? "Save recovery codes"
                : modal === "backup"
                  ? "Regenerate recovery codes"
                  : account.user.twoFactorEnabled
                    ? "Disable authenticator?"
                    : "Set up authenticator"}
            </DialogTitle>
            <DialogDescription>
              {backupCodes.length
                ? "Keep these codes somewhere safe. Each code can only be used once."
                : modal === "backup"
                  ? "Generating new recovery codes invalidates your previous codes."
                  : account.user.twoFactorEnabled
                    ? "Your account will no longer require an authenticator code at sign-in. Other devices will be signed out."
                    : "Add your account to an authenticator app, then confirm its six-digit code."}
            </DialogDescription>
          </DialogHeader>
          {feedback}
          <p className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="size-4" />
            {account.user.twoFactorEnabled
              ? "Authenticator protection is enabled."
              : "Protect your account with an authenticator app and recovery codes."}
          </p>
          {modal === "mfa" && !enrollment && !backupCodes.length ? (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                const data = fields(event);
                const form = event.currentTarget;
                const disabling = account.user.twoFactorEnabled;
                void run(
                  "mfa",
                  async () => {
                    const result = await accountRequest<{ totpURI: string; backupCodes: string[] }>(
                      disabling ? "/api/auth/two-factor/disable" : "/api/auth/two-factor/enable",
                      hasPassword ? { password: data.get("password") } : {},
                    );
                    if (!disabling) setEnrollment(result);
                    else {
                      setEnrollment(null);
                      setBackupCodes([]);
                      await notifyChanged();
                      setModal(null);
                    }
                    form.reset();
                  },
                  disabling
                    ? "Authenticator disabled. Other devices have been signed out."
                    : "Add the secret to your authenticator, then enter its code to finish setup.",
                );
              }}
            >
              {hasPassword ? (
                <Field label="Current password" id="mfa-password">
                  <PasswordInput
                    id="mfa-password"
                    name="password"
                    autoComplete="current-password"
                    maxLength={128}
                    required
                  />
                </Field>
              ) : null}
              {button(
                "mfa",
                account.user.twoFactorEnabled ? "Disable authenticator" : "Set up authenticator",
                !!enrollment,
              )}
            </form>
          ) : null}
          {enrollment ? (
            <div className="grid gap-4">
              <p className="text-sm text-muted-foreground">
                In your authenticator app, add an account manually using this setup key. Choose
                time-based codes.
              </p>
              <div className="flex items-center gap-2">
                <code className="break-all text-sm">
                  {new URL(enrollment.totpURI).searchParams.get("secret")}
                </code>
                <CopyButton
                  value={new URL(enrollment.totpURI).searchParams.get("secret") ?? ""}
                  label="Copy authenticator setup key"
                />
              </div>
              <a href={enrollment.totpURI} className="text-sm underline underline-offset-4">
                Open in your authenticator app
              </a>
              <form
                className="grid gap-4"
                onSubmit={(event) => {
                  const data = fields(event);
                  void run(
                    "mfa-confirm",
                    async () => {
                      await accountRequest("/api/auth/two-factor/verify-totp", {
                        code: data.get("code"),
                      });
                      setBackupCodes(enrollment.backupCodes);
                      setEnrollment(null);
                      await notifyChanged();
                    },
                    "Authenticator verified. Save your recovery codes below.",
                  );
                }}
              >
                <Field label="Authenticator code" id="mfa-confirm-code">
                  <Code id="mfa-confirm-code" />
                </Field>
                {button("mfa-confirm", "Confirm authenticator")}
              </form>
            </div>
          ) : null}
          {modal === "backup" && !backupCodes.length ? (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                const data = fields(event);
                const form = event.currentTarget;
                void run(
                  "backup",
                  async () => {
                    const result = await accountRequest<{ backupCodes: string[] }>(
                      "/api/auth/two-factor/generate-backup-codes",
                      hasPassword ? { password: data.get("password") } : {},
                    );
                    setBackupCodes(result.backupCodes);
                    form.reset();
                  },
                  "New recovery codes generated. Previous codes are no longer valid.",
                );
              }}
            >
              {hasPassword ? (
                <Field label="Current password" id="backup-password">
                  <PasswordInput
                    id="backup-password"
                    name="password"
                    autoComplete="current-password"
                    maxLength={128}
                    required
                  />
                </Field>
              ) : null}
              {button("backup", "Regenerate recovery codes")}
            </form>
          ) : null}
          {backupCodes.length ? (
            <div className="mt-4 grid gap-3 rounded-xl border p-4">
              <p className="text-sm">
                Save these codes securely. Each code can be used once if you lose your
                authenticator.
              </p>
              <div className="grid grid-cols-2 gap-2 font-mono text-sm">
                {backupCodes.map((code) => (
                  <span key={code}>{code}</span>
                ))}
              </div>
              <DialogFooter>
                <CopyButton value={backupCodes.join("\n")} label="Copy recovery codes" />
                <Button
                  variant="outline"
                  onClick={() => {
                    setBackupCodes([]);
                    setModal(null);
                  }}
                >
                  I saved my codes
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={modal === "delete"} onOpenChange={closeModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete account?</DialogTitle>
            <DialogDescription>
              This action cannot be undone. Confirm your email and account deletion below.
            </DialogDescription>
          </DialogHeader>
          {feedback}
          <p className="mb-4 text-sm text-muted-foreground">
            This permanently deletes your profile, sessions, linked login accounts and MFA
            credentials. Organization accounting and audit history follow the retention policy.
            External provider accounts are unaffected.
          </p>
          {account.ownedOrganizations.length ? (
            <div className="mb-4 text-sm">
              <p>Transfer ownership or delete these organizations first:</p>
              <ul className="mt-2 list-inside list-disc">
                {account.ownedOrganizations.map((org) => (
                  <li key={org.id}>
                    <Link
                      className="underline underline-offset-4"
                      href={`/org/${org.id}/settings?tab=general`}
                    >
                      {org.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              const data = fields(event);
              if (!deleteAcknowledged || account.ownedOrganizations.length) return;
              void run("delete", async () => {
                await accountRequest("/api/account/delete", {
                  confirmationEmail: data.get("confirmationEmail"),
                  ...(hasPassword ? { password: data.get("password") } : {}),
                });
                router.replace("/auth/login?account=deleted");
                router.refresh();
              });
            }}
          >
            <Field label={`Type ${account.user.email} to confirm`} id="delete-email">
              <Input
                id="delete-email"
                name="confirmationEmail"
                type="email"
                autoComplete="off"
                required
              />
            </Field>
            {hasPassword ? (
              <Field label="Current password" id="delete-password">
                <PasswordInput
                  id="delete-password"
                  name="password"
                  autoComplete="current-password"
                  maxLength={128}
                  required
                />
              </Field>
            ) : null}
            <div className="flex items-start gap-2">
              <Checkbox
                id="delete-acknowledged"
                checked={deleteAcknowledged}
                onCheckedChange={setDeleteAcknowledged}
                disabled={!!busy}
              />
              <Label htmlFor="delete-acknowledged" className="text-sm leading-relaxed">
                I understand this permanently deletes my account.
              </Label>
            </div>
            <DialogFooter>
              {cancel}
              <Button
                type="submit"
                variant="destructive-solid"
                disabled={!!busy || !deleteAcknowledged || account.ownedOrganizations.length > 0}
              >
                {busy === "delete" ? <LoaderCircle className="animate-spin" /> : null}Permanently
                delete account
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {confirmationDialog}
    </>
  );
}
