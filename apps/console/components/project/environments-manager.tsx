'use client'

import {
  Edit3,
  LoaderCircle,
  Lock,
  MoreHorizontal,
  Plus,
  Trash2,
} from 'lucide-react'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  createEnvironmentInputSchema,
  deleteEnvironmentInputSchema,
  projectSlugFromName,
  updateEnvironmentInputSchema,
} from '@relayrtc/validation'
import {
  createEnvironmentAction,
  deleteEnvironmentAction,
  updateEnvironmentAction,
} from '@/actions/projects'
import { DeletionProgress } from '@/components/settings/deletion-progress'
import type { RuntimeOperationView } from '@relayrtc/auth'
import { AuthErrorMessage } from '@/components/auth/auth-error-message'
import { CopyButton } from '@/components/page/copy-button'
import { PageHeader } from '@/components/page/page-header'
import { SimpleSelect } from '@/components/page/simple-select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ConsoleEnvironment } from '@/lib/console-types'
import {
  projectError,
  type ProjectError,
} from '@/lib/projects/project-errors'

type EnvironmentType = 'staging' | 'preview' | 'custom'

const typeOptions: {
  value: EnvironmentType
  label: string
}[] = [
  {
    value: 'staging',
    label: 'Staging',
  },
  {
    value: 'preview',
    label: 'Preview',
  },
  {
    value: 'custom',
    label: 'Custom',
  },
]

function formatCreatedAt(value: Date | string) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
  }).format(new Date(value))
}

export function EnvironmentsManager({
  projectId,
  environments,
  canManage,
}: {
  projectId: string
  environments: readonly ConsoleEnvironment[]
  canManage: boolean
}) {
  const router = useRouter()

  const createNameId = useId()
  const createSlugId = useId()
  const createTypeId = useId()

  const editNameId = useId()
  const editSlugId = useId()

  const [createOpen, setCreateOpen] = useState(false)

  const [createName, setCreateName] = useState('')
  const [createSlug, setCreateSlug] = useState('')
  const [createSlugEdited, setCreateSlugEdited] = useState(false)
  const [createType, setCreateType] =
    useState<EnvironmentType>('staging')
  const [createProtected, setCreateProtected] = useState(false)
  const [createPending, setCreatePending] = useState(false)
  const [createError, setCreateError] =
    useState<ProjectError | null>(null)

  const [editingEnvironment, setEditingEnvironment] =
    useState<ConsoleEnvironment | null>(null)
  const [editName, setEditName] = useState('')
  const [editSlug, setEditSlug] = useState('')
  const [editProtected, setEditProtected] = useState(false)
  const [editPending, setEditPending] = useState(false)
  const [editError, setEditError] =
    useState<ProjectError | null>(null)

  const [pendingDelete, setPendingDelete] =
    useState<ConsoleEnvironment | null>(null)
  const [deleteOperation, setDeleteOperation] = useState<RuntimeOperationView | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [deleteError, setDeleteError] =
    useState<ProjectError | null>(null)

  function closeCreate() {
    if (createPending) {
      return
    }

    setCreateOpen(false)
    setCreateName('')
    setCreateSlug('')
    setCreateSlugEdited(false)
    setCreateType('staging')
    setCreateProtected(false)
    setCreateError(null)
  }

  function openCreate() {
    setCreateName('')
    setCreateSlug('')
    setCreateSlugEdited(false)
    setCreateType('staging')
    setCreateProtected(false)
    setCreateError(null)
    setCreateOpen(true)
  }

  async function handleCreate(
    event: React.SyntheticEvent<HTMLFormElement>,
  ) {
    event.preventDefault()

    setCreateError(null)

    const validation = createEnvironmentInputSchema.safeParse({
      projectId,
      name: createName,
      slug: createSlug,
      type: createType,
      deletionProtected: createProtected,
    })

    if (!validation.success) {
      setCreateError(
        projectError('INVALID_ENVIRONMENT_INPUT'),
      )
      return
    }

    setCreatePending(true)

    const result = await createEnvironmentAction(validation.data)

    if (result.error) {
      setCreateError(result.error)
      setCreatePending(false)
      return
    }

    setCreatePending(false)
    closeCreate()

    router.refresh()
  }

  function openEdit(environment: ConsoleEnvironment) {
    setEditError(null)
    setEditName(environment.name)
    setEditSlug(environment.slug)
    setEditProtected(environment.deletionProtected)
    setEditingEnvironment(environment)
  }

  function closeEdit() {
    if (editPending) {
      return
    }

    setEditingEnvironment(null)
    setEditError(null)
    setEditName('')
    setEditSlug('')
    setEditProtected(false)
  }

  async function handleEdit(
    event: React.SyntheticEvent<HTMLFormElement>,
  ) {
    event.preventDefault()

    if (!editingEnvironment) {
      return
    }

    setEditError(null)

    const validation = updateEnvironmentInputSchema.safeParse({
      projectId,
      environmentId: editingEnvironment.id,
      name: editName,
      slug: editSlug,
      deletionProtected: editProtected,
    })

    if (!validation.success) {
      setEditError(
        projectError('INVALID_ENVIRONMENT_INPUT'),
      )
      return
    }

    setEditPending(true)

    const result = await updateEnvironmentAction(validation.data)

    if (result.error) {
      setEditError(result.error)
      setEditPending(false)
      return
    }

    setEditPending(false)
    closeEdit()

    router.refresh()
  }

  function openDelete(environment: ConsoleEnvironment) {
    if (environment.deletionProtected) {
      return
    }

    setDeleteError(null)
    setPendingDelete(environment)
  }

  function closeDelete() {
    if (deletePending) {
      return
    }

    setPendingDelete(null)
    setDeleteOperation(null)
    setDeleteError(null)
  }

  async function handleDelete() {
    if (!pendingDelete) {
      return
    }

    setDeleteError(null)

    const validation = deleteEnvironmentInputSchema.safeParse({
      projectId,
      environmentId: pendingDelete.id,
    })

    if (!validation.success) {
      setDeleteError(
        projectError('INVALID_ENVIRONMENT_INPUT'),
      )
      return
    }

    setDeletePending(true)

    let result
    try {
      result = await deleteEnvironmentAction(validation.data)
    } catch {
      setDeleteError(projectError('ENVIRONMENT_DELETION_FAILED'))
      setDeletePending(false)
      router.refresh()
      return
    }

    if (result.error) {
      setDeleteError(result.error)
      setDeletePending(false)
      return
    }

    setDeletePending(false)
    if (result.data.operation && result.data.operation.status !== 'completed') {
      setDeleteOperation(result.data.operation)
    } else {
      closeDelete()
    }
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Environments"
        description="Separate keys, rooms and usage for each stage of your application."
        actions={
          canManage ? (
            <Button
              size="lg"
              onClick={openCreate}
            >
              <Plus />
              New environment
            </Button>
          ) : null
        }
      />

      <ul className="grid gap-3">
        {environments.map((environment) => {
          const coreEnvironment =
            environment.type === 'development' ||
            environment.type === 'production'

          const deletionProtected =
            environment.deletionProtected || coreEnvironment

          return (
            <li
              key={environment.id}
              className="flex items-center gap-3 rounded-2xl bg-card p-4 sm:gap-4 sm:p-5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h2 className="text-base font-medium">
                    {environment.name}
                  </h2>

                  <Badge
                    variant="secondary"
                    className="capitalize"
                  >
                    {environment.type}
                  </Badge>

                  {environment.status === 'deleting' ? <Badge variant="outline">Deletion Pending...</Badge> : null}
                  {deletionProtected ? (
                    <Badge variant="outline">
                      <Lock data-icon="inline-start" />
                      Protected
                    </Badge>
                  ) : null}
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-0.5">
                    <span className="font-mono text-[0.8125rem]">
                      {environment.id}
                    </span>

                    <CopyButton
                      value={environment.id}
                      label={`Copy ${environment.name} ID`}
                    />
                  </span>

                  <span>
                    Created{' '}
                    {formatCreatedAt(environment.createdAt)}
                  </span>
                </div>
                {canManage && environment.status === 'deleting' ? (
                  <div className="mt-3">
                    <DeletionProgress kind="environment" resourceId={environment.id} />
                  </div>
                ) : null}
              </div>

              {canManage && environment.status !== 'deleting' ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={`Actions for ${environment.name}`}
                    className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted"
                  >
                    <MoreHorizontal className="size-4" />
                  </DropdownMenuTrigger>

                  <DropdownMenuContent
                    align="end"
                    className="w-48 rounded-xl p-1.5"
                  >
                    <DropdownMenuItem
                      className="gap-2 rounded-lg"
                      onClick={() => { openEdit(environment) }}
                    >
                      <Edit3 className="size-4" />
                      Edit environment
                    </DropdownMenuItem>

                    <DropdownMenuItem
                      disabled={deletionProtected}
                      className="gap-2 rounded-lg text-destructive focus:text-destructive"
                      onClick={() => { openDelete(environment) }}
                    >
                      {deletionProtected ? (
                        <Lock className="size-4" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}

                      {deletionProtected
                        ? 'Environment protected'
                        : 'Delete environment'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </li>
          )
        })}
      </ul>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (open) {
            setCreateOpen(true)
          } else {
            closeCreate()
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={(event) => { void handleCreate(event) }}
            className="grid gap-5"
          >
            <DialogHeader>
              <DialogTitle>
                New environment
              </DialogTitle>

              <DialogDescription>
                Environments get their own API keys and usage
                reporting.
              </DialogDescription>
            </DialogHeader>

            <AuthErrorMessage error={createError} />

            <div className="grid gap-2">
              <Label htmlFor={createNameId}>
                Name
              </Label>

              <Input
                id={createNameId}
                value={createName}
                onChange={(event) => {
                  const value = event.target.value

                  setCreateName(value)

                  if (!createSlugEdited) {
                    setCreateSlug(
                      projectSlugFromName(value),
                    )
                  }
                }}
                placeholder="e.g. QA"
                className="h-10 rounded-xl"
                maxLength={120}
                required
                autoFocus
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor={createSlugId}>
                Slug
              </Label>

              <Input
                id={createSlugId}
                value={createSlug}
                onChange={(event) => {
                  setCreateSlug(
                    event.target.value.toLowerCase(),
                  )
                  setCreateSlugEdited(true)
                }}
                placeholder="e.g. qa"
                className="h-10 rounded-xl"
                maxLength={80}
                required
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor={createTypeId}>
                Type
              </Label>

              <SimpleSelect
                id={createTypeId}
                value={createType}
                onValueChange={(value) => {
                  setCreateType(value as EnvironmentType)
                }}
                options={typeOptions}
                className="w-full"
              />
            </div>

            <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3">
              <Checkbox
                checked={createProtected}
                onCheckedChange={(checked) => {
                  setCreateProtected(checked)
                }}
                className="mt-0.5"
              />

              <span className="grid gap-0.5">
                <span className="text-sm font-medium">
                  Protect from deletion
                </span>

                <span className="text-sm text-muted-foreground">
                  The environment must be unprotected before it
                  can be deleted.
                </span>
              </span>
            </label>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={closeCreate}
                disabled={createPending}
              >
                Cancel
              </Button>

              <Button
                type="submit"
                disabled={
                  createPending ||
                  !createName.trim() ||
                  !createSlug.trim()
                }
              >
                {createPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : null}

                Create environment
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editingEnvironment !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeEdit()
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          {editingEnvironment ? (
            <form
              onSubmit={(event) => { void handleEdit(event) }}
              className="grid gap-5"
            >
              <DialogHeader>
                <DialogTitle>
                  Edit environment
                </DialogTitle>

                <DialogDescription>
                  Update this environment&apos;s name, slug and
                  deletion protection.
                </DialogDescription>
              </DialogHeader>

              <AuthErrorMessage error={editError} />

              <div className="grid gap-2">
                <Label htmlFor={editNameId}>
                  Name
                </Label>

                <Input
                  id={editNameId}
                  value={editName}
                  onChange={(event) => {
                    setEditName(event.target.value)
                  }}
                  className="h-10 rounded-xl"
                  maxLength={120}
                  required
                  autoFocus
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor={editSlugId}>
                  Slug
                </Label>

                <Input
                  id={editSlugId}
                  value={editSlug}
                  onChange={(event) => {
                    setEditSlug(event.target.value.toLowerCase())
                  }}
                  className="h-10 rounded-xl"
                  maxLength={80}
                  required
                />
              </div>

              <div className="grid gap-2">
                <Label>
                  Type
                </Label>

                <div className="flex h-10 items-center rounded-xl border bg-muted/40 px-3 text-sm capitalize text-muted-foreground">
                  {editingEnvironment.type}
                </div>
              </div>

              <label
                className={
                  editingEnvironment.type === 'development' ||
                  editingEnvironment.type === 'production'
                    ? 'flex cursor-not-allowed items-start gap-3 rounded-xl border p-3 opacity-70'
                    : 'flex cursor-pointer items-start gap-3 rounded-xl border p-3'
                }
              >
                <Checkbox
                  checked={editProtected}
                  disabled={
                    editingEnvironment.type ===
                      'development' ||
                    editingEnvironment.type ===
                      'production'
                  }
                  onCheckedChange={(checked) => {
                    setEditProtected(checked)
                  }}
                  className="mt-0.5"
                />

                <span className="grid gap-0.5">
                  <span className="text-sm font-medium">
                    Protect from deletion
                  </span>

                  <span className="text-sm text-muted-foreground">
                    {editingEnvironment.type ===
                      'development' ||
                    editingEnvironment.type ===
                      'production'
                      ? 'Development and Production environments are always protected.'
                      : 'The environment must be unprotected before it can be deleted.'}
                  </span>
                </span>
              </label>

              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={closeEdit}
                  disabled={editPending}
                >
                  Cancel
                </Button>

                <Button
                  type="submit"
                  disabled={
                    editPending ||
                    !editName.trim() ||
                    !editSlug.trim()
                  }
                >
                  {editPending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : null}

                  Save changes
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeDelete()
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {pendingDelete?.name}?
            </DialogTitle>

            <DialogDescription>
              Keys and rooms scoped to this environment will stop
              working. Live connections will close before deletion finishes.
              Usage history will be retained. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>

          <AuthErrorMessage error={deleteError} />
          {deleteOperation && pendingDelete ? (
            <DeletionProgress kind="environment" resourceId={pendingDelete.id} initialOperation={deleteOperation} />
          ) : null}

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={closeDelete}
              disabled={deletePending}
            >
              {deleteOperation ? 'Close' : 'Cancel'}
            </Button>

            <Button
              variant="destructive-solid"
              onClick={() => { void handleDelete() }}
              disabled={deletePending || deleteOperation !== null}
            >
              {deletePending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Trash2 />
              )}

              Delete environment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
