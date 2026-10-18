"use client";

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  KeyRound,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RotateCw,
  Search,
  Trash2,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { availableApiKeyScopes } from "@relayrtc/validation";
import { createApiKeyAction, revokeApiKeyAction, rotateApiKeyAction } from "@/actions/api-keys";
import { AuthErrorMessage } from "@/components/auth/auth-error-message";
import { CopyButton } from "@/components/page/copy-button";
import { PageHeader } from "@/components/page/page-header";
import { SimpleSelect } from "@/components/page/simple-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ApiKeyError } from "@/lib/api-keys/api-key-errors";
import type { ConsoleEnvironment } from "@/lib/console-types";

interface ApiKeyView {
  id: string;
  environmentId: string;
  projectId: string;
  name: string;
  type: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

function formatDate(value: string | null) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
  }).format(new Date(value));
}

export function ApiKeysManager({
  projectId,
  environments,
  apiKeys,
  canManage,
  defaultOpen = false,
}: {
  projectId: string;
  environments: readonly ConsoleEnvironment[];
  apiKeys: readonly ApiKeyView[];
  canManage: boolean;
  defaultOpen?: boolean;
}) {
  const router = useRouter();

  const searchId = useId();
  const nameId = useId();
  const environmentSelectId = useId();

  const developmentEnvironment =
    environments.find(
      (environment) => environment.type === "development" || environment.slug === "development",
    ) ?? environments[0];

  const defaultEnvironmentId = developmentEnvironment?.id ?? "";

  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(defaultOpen);
  const [name, setName] = useState("");
  const [environmentId, setEnvironmentId] = useState(defaultEnvironmentId);
  const [scopes, setScopes] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<ApiKeyError | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const [pendingRevoke, setPendingRevoke] = useState<ApiKeyView | null>(null);
  const [pendingRotate, setPendingRotate] = useState<ApiKeyView | null>(null);
  const [actionError, setActionError] = useState<ApiKeyError | null>(null);
  const [actionPending, setActionPending] = useState<"revoke" | "rotate" | null>(null);

  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);

  const environmentOptions = environments.map((environment) => ({
    value: environment.id,
    label: environment.name,
  }));

  const environmentMap = useMemo(
    () => new Map(environments.map((environment) => [environment.id, environment])),
    [environments],
  );

  const visibleKeys = useMemo(() => {
    const term = query.trim().toLowerCase();

    if (!term) {
      return apiKeys;
    }

    return apiKeys.filter((key) => {
      const environment = environmentMap.get(key.environmentId);

      return (
        key.name.toLowerCase().includes(term) ||
        key.prefix.toLowerCase().includes(term) ||
        environment?.name.toLowerCase().includes(term)
      );
    });
  }, [apiKeys, environmentMap, query]);

  function resetCreateDialog() {
    setCreateOpen(false);
    setName("");
    setEnvironmentId(defaultEnvironmentId);
    setScopes([]);
    setCreateError(null);
    setSecret(null);
    setCreating(false);
  }

  function openCreateDialog() {
    setName("");
    setEnvironmentId(defaultEnvironmentId);
    setScopes([]);
    setCreateError(null);
    setSecret(null);
    setCreateOpen(true);
  }

  function toggleScope(scope: string, checked: boolean) {
    setScopes((current) => {
      if (checked) {
        return current.includes(scope) ? current : [...current, scope];
      }

      return current.filter((value) => value !== scope);
    });
  }

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!name.trim() || !environmentId) {
      return;
    }

    setCreateError(null);
    setCreating(true);

    const result = await createApiKeyAction({
      projectId,
      environmentId,
      name: name.trim(),
      type: "secret",
      scopes,
      expiresAt: null,
    });

    if (result.error) {
      setCreateError(result.error);
      setCreating(false);
      return;
    }

    setSecret(result.data.rawKey);
    setCreating(false);
    router.refresh();
  }

  async function handleRotate() {
    if (!pendingRotate) {
      return;
    }

    setActionError(null);
    setActionPending("rotate");

    const result = await rotateApiKeyAction({
      apiKeyId: pendingRotate.id,
      projectId,
    });

    if (result.error) {
      setActionError(result.error);
      setActionPending(null);
      return;
    }

    setPendingRotate(null);
    setActionPending(null);
    setRotatedSecret(result.data.rawKey);

    router.refresh();
  }

  async function handleRevoke() {
    if (!pendingRevoke) {
      return;
    }

    setActionError(null);
    setActionPending("revoke");

    const result = await revokeApiKeyAction({
      apiKeyId: pendingRevoke.id,
      projectId,
    });

    if (result.error) {
      setActionError(result.error);
      setActionPending(null);
      return;
    }

    setPendingRevoke(null);
    setActionPending(null);

    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="API keys"
        description="Keys authenticate your server when minting participant tokens."
        actions={
          canManage ? (
            <Button size="lg" onClick={openCreateDialog}>
              <Plus />
              Create API key
            </Button>
          ) : null
        }
      />

      <div className="relative w-full sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />

        <Label htmlFor={searchId} className="sr-only">
          Search API keys
        </Label>

        <Input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          className="h-11 rounded-xl bg-card pl-10"
        />
      </div>

      {visibleKeys.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-16 text-center">
          <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
            <KeyRound className="size-5" />
          </span>

          <p className="font-medium">{query ? "No keys match your search" : "No API keys yet"}</p>

          <p className="max-w-xs text-sm text-muted-foreground">
            {query ? "Try a different name." : "Create a key to start minting participant tokens."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full min-w-[36rem] text-sm">
            <TableHeader>
              <TableRow className="border-b text-left text-muted-foreground">
                <TableHead scope="col" className="px-2 pb-3 font-normal">
                  Name
                </TableHead>

                <TableHead scope="col" className="px-2 pb-3 font-normal">
                  Key
                </TableHead>

                <TableHead scope="col" className="hidden px-2 pb-3 font-normal md:table-cell">
                  Environment
                </TableHead>

                <TableHead scope="col" className="px-2 pb-3 font-normal">
                  Last used
                </TableHead>

                <TableHead scope="col" className="w-12 pb-3">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {visibleKeys.map((key) => {
                const environment = environmentMap.get(key.environmentId);

                const expired = key.expiresAt !== null && new Date(key.expiresAt) <= new Date();

                const inactive = key.revokedAt !== null || expired;

                return (
                  <TableRow key={key.id} className="border-b last:border-0">
                    <TableCell className="px-2 py-4 text-[0.9375rem]">
                      <div className="flex items-center gap-2">
                        <span>{key.name}</span>

                        {key.revokedAt ? (
                          <Badge variant="secondary" className="text-xs">
                            Revoked
                          </Badge>
                        ) : expired ? (
                          <Badge variant="secondary" className="text-xs">
                            Expired
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>

                    <TableCell className="px-2 py-4 font-mono text-[0.8125rem] text-muted-foreground">
                      {key.prefix}...
                    </TableCell>

                    <TableCell className="hidden px-2 py-4 md:table-cell">
                      <Badge variant="secondary" className="capitalize">
                        {environment?.name ?? "Unknown"}
                      </Badge>
                    </TableCell>

                    <TableCell className="px-2 py-4 text-muted-foreground">
                      {formatDate(key.lastUsedAt)}
                    </TableCell>

                    <TableCell className="py-2 text-right">
                      {canManage && !inactive ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label={`Actions for ${key.name}`}
                            className="inline-grid size-8 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted"
                          >
                            <MoreHorizontal className="size-4" />
                          </DropdownMenuTrigger>

                          <DropdownMenuContent align="end" className="w-44 rounded-xl p-1.5">
                            <DropdownMenuItem
                              className="gap-2 rounded-lg"
                              onClick={() => {
                                setActionError(null);
                                setPendingRotate(key);
                              }}
                            >
                              <RotateCw className="size-4" />
                              Rotate key
                            </DropdownMenuItem>

                            <DropdownMenuItem
                              className="gap-2 rounded-lg text-destructive focus:text-destructive"
                              onClick={() => {
                                setActionError(null);
                                setPendingRevoke(key);
                              }}
                            >
                              <Trash2 className="size-4" />
                              Revoke key
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (open) {
            setCreateOpen(true);
          } else {
            resetCreateDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          {secret ? (
            <>
              <DialogHeader>
                <DialogTitle>Save your API key</DialogTitle>

                <DialogDescription>
                  This is the only time the full key is shown. Store it somewhere safe.
                </DialogDescription>
              </DialogHeader>

              <div className="flex items-center gap-1 rounded-xl border bg-muted/50 py-1.5 pl-3 pr-1.5">
                <code className="min-w-0 flex-1 break-all font-mono text-[0.8125rem]">
                  {secret}
                </code>

                <CopyButton value={secret} label="Copy API key" />
              </div>

              <DialogFooter>
                <Button onClick={resetCreateDialog}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={handleCreate} className="grid gap-5">
              <DialogHeader>
                <DialogTitle>Create API key</DialogTitle>

                <DialogDescription>Scope a new key to a single environment.</DialogDescription>
              </DialogHeader>

              <AuthErrorMessage error={createError} />

              <div className="grid gap-2">
                <Label htmlFor={nameId}>Name</Label>

                <Input
                  id={nameId}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Production server"
                  className="h-10 rounded-xl"
                  required
                  autoFocus
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor={environmentSelectId}>Environment</Label>

                <SimpleSelect
                  id={environmentSelectId}
                  value={environmentId}
                  onValueChange={setEnvironmentId}
                  options={environmentOptions}
                  className="w-full"
                />
              </div>

              <div className="grid gap-3">
                <div>
                  <Label>Scopes</Label>

                  <p className="mt-1 text-xs text-muted-foreground">
                    Choose what this key is allowed to access.
                  </p>
                </div>

                <div className="grid gap-2">
                  {availableApiKeyScopes.map((scope) => {
                    const checked = scopes.includes(scope);

                    return (
                      <label
                        key={scope}
                        className="flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors hover:bg-muted/50"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(value) => toggleScope(scope, value === true)}
                        />

                        <span className="font-mono text-sm">{scope}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={resetCreateDialog}
                  disabled={creating}
                >
                  Cancel
                </Button>

                <Button type="submit" disabled={creating || !name.trim() || !environmentId}>
                  {creating ? <LoaderCircle className="animate-spin" /> : null}
                  Create key
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingRotate !== null}
        onOpenChange={(open) => {
          if (!open && actionPending === null) {
            setPendingRotate(null);
            setActionError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rotate {pendingRotate?.name}?</DialogTitle>

            <DialogDescription>
              The current key will stop working immediately and a new key will be generated.
            </DialogDescription>
          </DialogHeader>

          <AuthErrorMessage error={actionError} />

          <DialogFooter>
            <Button
              variant="ghost"
              disabled={actionPending !== null}
              onClick={() => {
                setPendingRotate(null);
                setActionError(null);
              }}
            >
              Cancel
            </Button>

            <Button onClick={handleRotate} disabled={actionPending !== null}>
              {actionPending === "rotate" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <RotateCw />
              )}
              Rotate key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={rotatedSecret !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRotatedSecret(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save your new API key</DialogTitle>

            <DialogDescription>
              This is the only time the full rotated key is shown. Store it somewhere safe.
            </DialogDescription>
          </DialogHeader>

          {rotatedSecret ? (
            <div className="flex items-center gap-1 rounded-xl border bg-muted/50 py-1.5 pl-3 pr-1.5">
              <code className="min-w-0 flex-1 break-all font-mono text-[0.8125rem]">
                {rotatedSecret}
              </code>

              <CopyButton value={rotatedSecret} label="Copy API key" />
            </div>
          ) : null}

          <DialogFooter>
            <Button onClick={() => setRotatedSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open && actionPending === null) {
            setPendingRevoke(null);
            setActionError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke {pendingRevoke?.name}?</DialogTitle>

            <DialogDescription>
              Any server using this key will immediately stop being able to authenticate. This
              can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>

          <AuthErrorMessage error={actionError} />

          <DialogFooter>
            <Button
              variant="ghost"
              disabled={actionPending !== null}
              onClick={() => {
                setPendingRevoke(null);
                setActionError(null);
              }}
            >
              Cancel
            </Button>

            <Button
              variant="destructive-solid"
              disabled={actionPending !== null}
              onClick={handleRevoke}
            >
              {actionPending === "revoke" ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              Revoke key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
