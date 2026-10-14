"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CopyButton } from "@/components/page/copy-button";
import { SectionHeading, SettingList, SettingRow } from "@/components/page/setting-row";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AccountSecurity } from "@/components/settings/account-security";
import { accountRequest, type AccountOverview } from "@/lib/account-api";

export function ProfileSettings() {
  const router = useRouter();
  const [account, setAccount] = useState<AccountOverview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const load = useCallback(async () => {
    setAccount(await accountRequest<AccountOverview>("/api/account"));
  }, []);
  useEffect(() => {
    let active = true;
    accountRequest<AccountOverview>("/api/account")
      .then((data) => {
        if (active) setAccount(data);
      })
      .catch((error: Error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    setNotice("");
    try {
      await accountRequest("/api/auth/update-user", {
        name: data.get("name"),
        image: data.get("image") || null,
      });
      await load();
      router.refresh();
      setNotice("Your profile has been updated.");
      setEditing(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to update your profile.");
    } finally {
      setPending(false);
    }
  }
  if (!account)
    return (
      <div role="status" className="py-8 text-sm text-muted-foreground">
        {error || "Loading your account…"}
        {error ? (
          <Button
            className="ml-3"
            variant="outline"
            onClick={() => {
              setError("");
              void load().catch((error: Error) => setError(error.message));
            }}
          >
            Retry
          </Button>
        ) : null}
      </div>
    );
  const user = account.user;
  const initials = user.name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <div className="flex items-center gap-4">
        <Avatar size="lg">
          {user.image ? <AvatarImage src={user.image} alt={user.name} /> : null}
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <div>
          <h1 className="text-2xl font-normal tracking-tight">Account</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your personal profile and account security.
          </p>
        </div>
      </div>
      {error && !editing ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <section aria-label="Profile">
        <SectionHeading
          action={
            <Button
              variant="outline"
              onClick={() => {
                setError("");
                setNotice("");
                setEditing(true);
              }}
            >
              Edit profile
            </Button>
          }
        >
          Profile
        </SectionHeading>
        <SettingList>
          <SettingRow label="Name">{user.name}</SettingRow>
          <SettingRow label="Email">
            {user.email}
            <span className="ml-2 text-xs text-muted-foreground">
              {user.emailVerified ? "Verified" : "Unverified"}
            </span>
          </SettingRow>
          <SettingRow label="User ID">
            <span className="inline-flex items-center gap-1">
              <span className="break-all font-mono text-xs">{user.id}</span>
              <CopyButton value={user.id} label="Copy user ID" />
            </span>
          </SettingRow>
        </SettingList>
      </section>
      <Dialog
        open={editing}
        onOpenChange={(open) => {
          if (!pending) setEditing(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit profile</DialogTitle>
            <DialogDescription>Update your display name and profile image.</DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <form onSubmit={save} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="profile-name">Name</Label>
              <Input
                id="profile-name"
                name="name"
                defaultValue={user.name}
                maxLength={120}
                required
                autoComplete="name"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="profile-image">Avatar URL</Label>
              <Input
                id="profile-image"
                name="image"
                type="url"
                defaultValue={user.image ?? ""}
                placeholder="https://?"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving?" : "Save profile"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AccountSecurity
        account={account}
        onChange={async () => {
          await load();
          router.refresh();
        }}
      />
      <p className="text-sm text-muted-foreground">
        Review security activity in{" "}
        <Link
          href="?tab=profile-audit-logs"
          className="text-foreground underline underline-offset-4"
        >
          Personal audit logs
        </Link>
        .
      </p>
    </div>
  );
}
