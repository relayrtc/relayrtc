"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "./account-provider";
import { AccountDialogForm, accountDialogTitles, type AccountDialog } from "./account-dialog-form";
import { ProviderIcon } from "@/ui/provider-icon";
import { AccountAvatar } from "@/ui/account-avatar";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Icon } from "@/ui/icon";
import { SettingsRow } from "@/ui/settings-row";
import { FormFeedback } from "@/ui/auth-fields";
import { useWorkspace } from "./workspace-provider";

export function Account() {
  const { account } = useAccount();
  const workspace = useWorkspace();
  const [dialog, setDialog] = useState<AccountDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [providerError, setProviderError] = useState("");
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.has("error")) setProviderError("The sign-in provider couldn’t be connected. Please try again.");
  }, []);
  const close = useCallback(() => setDialog(null), []);
  const hasPassword = account.accounts.some(item => item.providerId === "credential");
  return <section className="content account-content" aria-label="Account settings">
    <div className="profile-area"><button className="profile-avatar-button" aria-label="Edit profile" onClick={() => setDialog("profile")}><AccountAvatar size={94.5} name={account.user.name} image={account.user.image} /><span className="avatar-add"><Icon name="plus" size={19.6875} /></span></button></div>
    <FormFeedback error={providerError} />
    <div className="panel login-method-panel"><SettingsRow icon="account" label="Name" value={account.user.name} onClick={() => setDialog("profile")} /><SettingsRow icon="email" label="Email Address" value={account.user.email} onClick={account.emailDeliveryEnabled === false ? undefined : () => { setDialog("email"); }} trailing={account.emailDeliveryEnabled === false ? <></> : undefined} />{!account.user.emailVerified && account.emailDeliveryEnabled !== false && <SettingsRow icon="shield" label="Verify your email" value="Unverified" onClick={() => setDialog("verify-email")} />}</div>
    <section className="settings-section"><h2>Authentication</h2><div className="panel"><SettingsRow icon="password" label="Password" value={hasPassword ? "Enabled" : "Set password"} onClick={() => setDialog("password")} /><SettingsRow icon="shield" label="Two-factor authentication" value={account.user.twoFactorEnabled ? "Enabled" : "Set up"} onClick={() => setDialog("mfa")} />{account.user.twoFactorEnabled && <SettingsRow icon="secretKeys" label="Recovery codes" value="Regenerate" onClick={() => setDialog("codes")} />}</div></section>
    {(Boolean(account.socialProviders?.length) || account.accounts.some(item => ["google", "github"].includes(item.providerId))) && <section className="settings-section" id="connected-accounts"><h2>Connected accounts</h2><div className="panel">{(Boolean(account.socialProviders?.includes("google")) || account.accounts.some(item => item.providerId === "google")) && <SettingsRow icon="link" leading={<ProviderIcon provider="google" />} label="Google" value={account.accounts.some(item => item.providerId === "google") ? "Connected" : "Connect"} onClick={() => setDialog("google")} />}{(Boolean(account.socialProviders?.includes("github")) || account.accounts.some(item => item.providerId === "github")) && <SettingsRow icon="link" leading={<ProviderIcon provider="github" />} label="GitHub" value={account.accounts.some(item => item.providerId === "github") ? "Connected" : "Connect"} onClick={() => setDialog("github")} />}</div></section>}
    <section className="settings-section"><h2>Security</h2><div className="panel"><SettingsRow icon="device" label="Sessions and devices" href="/account/sessions" /><SettingsRow icon="history" label="Security activity" href="/account/activity" /></div></section>
    <section className="settings-section"><h2>Workspace</h2><div className="panel"><SettingsRow icon="organization" label="Organizations" value={workspace.organization?.name} href="/organizations" /><SettingsRow icon="project" label="Projects" value={workspace.project?.name} href="/projects" /></div></section>
    <section className="settings-section"><h2>Account</h2><div className="panel"><SettingsRow icon="trash" label="Delete account" className="text-danger" onClick={() => setDialog("delete")} /></div><p className="account-section-note">Manage your personal account and sign-in methods.</p></section>
    <Button className="logout-button" icon="logout" onClick={() => setDialog("logout")}>Logout</Button>
    <Dialog open={dialog !== null} title={dialog ? accountDialogTitles[dialog] : ""} dismissible={!busy} onClose={() => { if (!busy) close(); }}>
      {dialog && <AccountDialogForm key={dialog} view={dialog} onDone={close} onBusy={setBusy} />}
    </Dialog>
  </section>;
}
