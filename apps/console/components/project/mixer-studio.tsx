"use client";
import { Checkbox } from "@/components/ui/checkbox";
import { useStreamWorkspace } from "./stream-workspace";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Plus, RefreshCw, Layers } from "lucide-react";
import type {
  MixerResource,
  MixerScene,
  MixerSceneResource,
  MixerOperation,
} from "@relayrtc/types";
import {
  listMixersAction,
  getMixerAction,
  createMixerAction,
  listMixerScenesAction,
  saveMixerSceneAction,
  activateMixerSceneAction,
  stopMixerAction,
  getMixerOperationAction,
  addMixerOverlayAction,
  removeMixerOverlayAction,
} from "@/actions/mixers";
import { PageHeader } from "@/components/page/page-header";
import { SimpleSelect } from "@/components/page/simple-select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import type { ConsoleEnvironment } from "@/lib/console-types";
import { StreamPreview } from "./stream-preview";

const initialScene = (): MixerScene => ({
  name: "Main scene",
  layout: "single",
  background: "#000000",
  layers: [
    { sourceId: "primary", x: 0, y: 0, width: 640, height: 360, z: 0, fit: "contain", opacity: 1 },
  ],
  overlays: [],
  texts: [],
  audio: [{ sourceId: "primary", gainDb: 0, muted: false }],
  ducking: null,
  transition: "cut",
});
export function MixerStudio({
  projectId,
  environmentId,
  environments,
  broadcasts,
  streams,
  canManage,
  initialError,
}: {
  projectId: string;
  environmentId: string;
  environments: readonly ConsoleEnvironment[];
  broadcasts: { id: string; streamId: string; name: string; state: string }[];
  streams: { id: string; name: string }[];
  canManage: boolean;
  initialError: string | null;
}) {
  const workspace = useStreamWorkspace();
  const router = useRouter(),
    pathname = usePathname();
  const [broadcastId, setBroadcastId] = useState(workspace?.broadcastId ?? broadcasts[0]?.id ?? ""),
    [mixer, setMixer] = useState<MixerResource | null>(null),
    [history, setHistory] = useState<MixerResource[]>([]),
    [scenes, setScenes] = useState<MixerSceneResource[]>([]),
    [operation, setOperation] = useState<MixerOperation | null>(null);
  const [draft, setDraft] = useState<MixerScene>(initialScene),
    [sceneId, setSceneId] = useState("main"),
    [sceneVersion, setSceneVersion] = useState(0),
    [error, setError] = useState(initialError),
    [pending, setPending] = useState(false),
    [creating, setCreating] = useState(false),
    [stopping, setStopping] = useState(false),
    [secondary, setSecondary] = useState<string[]>(["", "", ""]);
  const selected = useRef<string | null>(null),
    loaded = useRef<string | null>(null),
    revision = useRef(0),
    commandKeys = useRef(new Map<string, string>()),
    operationId = useRef<string | null>(null),
    polling = useRef(false);
  const invalidate = useCallback(() => {
    revision.current++;
  }, []);
  const refresh = useCallback(async () => {
    if (!broadcastId || polling.current) return;
    polling.current = true;
    const rev = ++revision.current;
    try {
      const scope = { projectId, environmentId },
        listed = await listMixersAction({ ...scope, broadcastId });
      if (rev !== revision.current) return;
      if (listed.error) {
        setError(listed.error.description);
        return;
      }
      setHistory(listed.data.data);
      const key =
        selected.current ??
        listed.data.data.find((m) => !["stopped", "failed"].includes(m.state))?.id ??
        listed.data.data[0]?.id;
      if (!key) {
        setMixer(null);
        setScenes([]);
        return;
      }
      selected.current = key;
      const [detail, saved, observed] = await Promise.all([
        getMixerAction({ ...scope, mixerId: key }),
        listMixerScenesAction({ ...scope, mixerId: key }),
        operationId.current
          ? getMixerOperationAction({ ...scope, operationId: operationId.current })
          : Promise.resolve(null),
      ]);
      if (rev !== revision.current) return;
      if (detail.data) setMixer(detail.data);
      else setError(detail.error.description);
      if (saved.data) {
        setScenes(saved.data.data);
        if (loaded.current !== key) {
          loaded.current = key;
          const first = saved.data.data[0];
          if (first) {
            setDraft(first.scene);
            setSceneId(first.id);
            setSceneVersion(first.version);
          } else {
            setDraft(initialScene());
            setSceneId("main");
            setSceneVersion(0);
          }
        }
      }
      if (observed?.data) setOperation(observed.data);
    } catch {
      if (rev === revision.current) setError("Studio status is unavailable. Try again.");
    } finally {
      polling.current = false;
    }
  }, [projectId, environmentId, broadcastId]);
  useEffect(() => {
    const kickoff = setTimeout(() => {
      void refresh();
    }, 0);
    const timer = setInterval(() => {
      void refresh();
    }, 4000);
    return () => {
      clearTimeout(kickoff);
      clearInterval(timer);
      invalidate();
    };
  }, [refresh, invalidate]);
  const requestKey = (kind: string, payload: unknown) => {
    const identity = `${kind}:${JSON.stringify(payload)}`,
      key = commandKeys.current.get(identity) ?? crypto.randomUUID();
    commandKeys.current.set(identity, key);
    return { identity, key };
  };
  async function run<T>(
    kind: string,
    payload: unknown,
    request: (
      key: string,
    ) => Promise<{ data: T; error: null } | { data: null; error: { description: string } }>,
    apply: (data: NonNullable<T>) => void,
  ) {
    if (pending) return;
    invalidate();
    setPending(true);
    setError(null);
    const command = requestKey(kind, payload);
    try {
      const result = await request(command.key);
      if (result.error) setError(result.error.description);
      else if (result.data === null || result.data === undefined)
        setError("Command returned no resource.");
      else {
        commandKeys.current.delete(command.identity);
        apply(result.data);
        await refresh();
      }
    } catch {
      setError("Command could not be confirmed. Retry the same request.");
    } finally {
      setPending(false);
    }
  }
  function changeMixer(id: string) {
    if (pending) return;
    invalidate();
    selected.current = id;
    loaded.current = null;
    operationId.current = null;
    setOperation(null);
    void refresh();
  }
  function chooseScene(id: string) {
    if (pending) return;
    const scene = scenes.find((s) => s.id === id);
    if (scene) {
      setSceneId(scene.id);
      setSceneVersion(scene.version);
      setDraft(scene.scene);
    }
  }
  const scope = { projectId, environmentId },
    editable =
      !!mixer &&
      canManage &&
      mixer.state !== "stopping" &&
      !["stopped", "failed"].includes(mixer.state) &&
      !pending;
  const sources = mixer?.sources ?? [],
    nextZ = () =>
      Math.max(
        -1,
        ...draft.layers.map((l) => l.z),
        ...draft.overlays.map((l) => l.z),
        ...draft.texts.map((l) => l.z),
      ) + 1;
  const selectedBroadcast = workspace?.broadcast ?? broadcasts.find((b) => b.id === broadcastId);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Mixer studio"
        description="Combine multiple cameras, screen shares or streams into one picture. Choose their layout and switch scenes during the broadcast."
        actions={
          <Button
            disabled={
              !canManage ||
              !broadcastId ||
              pending ||
              (!!mixer && !["stopped", "failed"].includes(mixer.state))
            }
            onClick={() => setCreating(true)}
          >
            <Plus />
            Create mixer
          </Button>
        }
      />
      <div className="flex flex-wrap gap-3">
        {!workspace && (
          <SimpleSelect
            aria-label="Environment"
            value={environmentId}
            onValueChange={(id) =>
              router.push(`${pathname}?environmentId=${encodeURIComponent(id)}`)
            }
            options={environments.map((e) => ({ value: e.id, label: e.name }))}
          />
        )}
        {!workspace && (
          <SimpleSelect
            aria-label="Broadcast"
            value={broadcastId}
            onValueChange={(id) => {
              if (pending) return;
              invalidate();
              selected.current = null;
              loaded.current = null;
              operationId.current = null;
              setMixer(null);
              setOperation(null);
              setBroadcastId(id);
            }}
            options={broadcasts.map((b) => ({ value: b.id, label: `${b.name} (${b.state})` }))}
          />
        )}
        {history.length > 0 && (
          <SimpleSelect
            aria-label="Mixer"
            value={mixer?.id ?? ""}
            onValueChange={changeMixer}
            options={history.map((m) => ({ value: m.id, label: `${m.state}: ${m.id}` }))}
          />
        )}
        <Button variant="outline" disabled={pending} onClick={() => void refresh()}>
          <RefreshCw />
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!broadcastId && (
        <p className="text-sm text-muted-foreground">
          Create a broadcast first, then select it here.
        </p>
      )}
      {mixer && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Badge>{mixer.state}</Badge>
            <p role="status" className="text-sm">
              Requested revision {mixer.desiredVersion}; confirmed program revision{" "}
              {mixer.appliedVersion}.
            </p>
            {operation && (
              <p className="text-sm">
                {operation.kind}: {operation.status} · {operation.id}
                {operation.errorCode ? ` · ${operation.errorCode}` : ""}
              </p>
            )}
            <Button variant="outline" disabled={!editable} onClick={() => setStopping(true)}>
              Stop mixer
            </Button>
          </div>
          {(mixer.lastError || mixer.lostSources.length > 0) && (
            <p role="status" className="text-sm text-amber-600">
              {mixer.lastError}{" "}
              {mixer.lostSources.length > 0
                ? `Unavailable: ${mixer.lostSources.join(", ")}. The program uses black video and silence for missing inputs.`
                : ""}
            </p>
          )}
          <div className="grid gap-6 xl:grid-cols-2">
            <section className="space-y-3 rounded-xl border p-4">
              <h2 className="font-medium">Draft scene</h2>
              <p className="text-sm text-muted-foreground">
                Layout guide only. Save and activate to change the server program.
              </p>
              <SceneDraft scene={draft} />
              <div className="flex flex-wrap gap-2">
                <SimpleSelect
                  aria-label="Scene"
                  value={sceneVersion ? sceneId : ""}
                  onValueChange={chooseScene}
                  options={scenes.map((s) => ({
                    value: s.id,
                    label: `${s.scene.name} · v${s.version}`,
                  }))}
                />
                <Button
                  variant="outline"
                  disabled={!editable || scenes.length >= 12}
                  onClick={() => {
                    setSceneId(crypto.randomUUID());
                    setSceneVersion(0);
                    setDraft(initialScene());
                  }}
                >
                  <Plus />
                  New scene
                </Button>
                <Button
                  variant="outline"
                  disabled={pending || !scenes.some((s) => s.id === sceneId)}
                  onClick={() => chooseScene(sceneId)}
                >
                  Reload saved scene
                </Button>
              </div>
              <Label htmlFor="scene-name">Scene name</Label>
              <Input
                id="scene-name"
                value={draft.name}
                disabled={!editable}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <SimpleSelect
                aria-label="Layout"
                value={draft.layout}
                onValueChange={(layout) =>
                  setDraft({
                    ...draft,
                    layout: layout as MixerScene["layout"],
                    layers:
                      layout === "single"
                        ? draft.layers.slice(0, 1)
                        : layout === "pip"
                          ? draft.layers.slice(0, 2)
                          : draft.layers,
                  })
                }
                options={[
                  { value: "single", label: "Single source" },
                  { value: "grid", label: "Grid" },
                  { value: "pip", label: "Picture in picture" },
                  { value: "custom", label: "Custom positions" },
                ]}
              />
              <Label htmlFor="scene-background">Background</Label>
              <Input
                id="scene-background"
                type="color"
                value={draft.background}
                disabled={!editable}
                onChange={(e) => setDraft({ ...draft, background: e.target.value })}
              />
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Video sources</h3>
                {draft.layers.map((layer, index) => (
                  <div key={index} className="space-y-2 rounded-lg border p-3">
                    <div className="flex gap-2">
                      <SimpleSelect
                        aria-label={`Layer ${index + 1} source`}
                        value={layer.sourceId}
                        options={sources.map((s) => ({
                          value: s.id,
                          label: s.id === "primary" ? "Primary source" : s.id,
                        }))}
                        onValueChange={(sourceId) =>
                          setDraft({
                            ...draft,
                            layers: draft.layers.map((l, i) =>
                              i === index ? { ...l, sourceId } : l,
                            ),
                          })
                        }
                      />
                      <SimpleSelect
                        aria-label={`Layer ${index + 1} fit`}
                        value={layer.fit}
                        options={[
                          { value: "contain", label: "Fit" },
                          { value: "cover", label: "Crop to fill" },
                        ]}
                        onValueChange={(fit) =>
                          setDraft({
                            ...draft,
                            layers: draft.layers.map((l, i) =>
                              i === index ? { ...l, fit: fit as "contain" | "cover" } : l,
                            ),
                          })
                        }
                      />
                      <Button
                        variant="ghost"
                        disabled={!editable}
                        onClick={() =>
                          setDraft({ ...draft, layers: draft.layers.filter((_, i) => i !== index) })
                        }
                      >
                        Remove
                      </Button>
                    </div>
                    {draft.layout === "custom" && (
                      <BoxEditor
                        value={layer}
                        disabled={!editable}
                        onChange={(box) =>
                          setDraft({
                            ...draft,
                            layers: draft.layers.map((l, i) =>
                              i === index ? { ...l, ...box } : l,
                            ),
                          })
                        }
                      />
                    )}
                  </div>
                ))}
                <Button
                  variant="outline"
                  disabled={
                    !editable ||
                    draft.layers.length >=
                      (draft.layout === "single" ? 1 : draft.layout === "pip" ? 2 : 4)
                  }
                  onClick={() =>
                    setDraft({
                      ...draft,
                      layers: [
                        ...draft.layers,
                        {
                          sourceId: "primary",
                          x: 0,
                          y: 0,
                          width: 320,
                          height: 180,
                          z: nextZ(),
                          fit: "contain",
                          opacity: 1,
                        },
                      ],
                    })
                  }
                >
                  <Plus />
                  Video layer
                </Button>
              </div>
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Audio mix</h3>
                {sources.map((source) => {
                  const audio = draft.audio.find((a) => a.sourceId === source.id);
                  return (
                    <div key={source.id} className="flex flex-wrap items-center gap-3">
                      <Label className="flex items-center gap-2 text-sm leading-relaxed">
                        <Checkbox
                          disabled={!editable}
                          checked={!!audio}
                          onCheckedChange={(e) =>
                            setDraft({
                              ...draft,
                              audio: e
                                ? [...draft.audio, { sourceId: source.id, gainDb: 0, muted: false }]
                                : draft.audio.filter((a) => a.sourceId !== source.id),
                              ducking: draft.ducking?.sourceId === source.id ? null : draft.ducking,
                            })
                          }
                        />
                        {source.id}
                      </Label>
                      {audio && (
                        <>
                          <Label className="text-sm">
                            Gain dB
                            <Input
                              className="w-24"
                              type="number"
                              min={-60}
                              max={12}
                              disabled={!editable}
                              value={audio.gainDb}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  audio: draft.audio.map((a) =>
                                    a.sourceId === source.id
                                      ? { ...a, gainDb: Number(e.target.value) }
                                      : a,
                                  ),
                                })
                              }
                            />
                          </Label>
                          <Label className="flex items-center gap-2 text-sm leading-relaxed">
                            <Checkbox
                              checked={audio.muted}
                              disabled={!editable}
                              onCheckedChange={(e) =>
                                setDraft({
                                  ...draft,
                                  audio: draft.audio.map((a) =>
                                    a.sourceId === source.id ? { ...a, muted: e } : a,
                                  ),
                                })
                              }
                            />
                            Mute
                          </Label>
                        </>
                      )}
                    </div>
                  );
                })}
                <SimpleSelect
                  aria-label="Audio ducking source"
                  value={draft.ducking?.sourceId ?? "none"}
                  options={[
                    { value: "none", label: "No ducking" },
                    ...draft.audio.map((a) => ({
                      value: a.sourceId,
                      label: `Duck other inputs when ${a.sourceId} speaks`,
                    })),
                  ]}
                  onValueChange={(sourceId) =>
                    setDraft({
                      ...draft,
                      ducking:
                        sourceId === "none"
                          ? null
                          : { sourceId, threshold: 0.1, attenuationDb: 12 },
                    })
                  }
                />
              </div>
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Text overlays</h3>
                {draft.texts.map((text, index) => (
                  <div key={text.id} className="space-y-2 rounded-lg border p-3">
                    <Input
                      aria-label="Overlay text"
                      value={text.text}
                      disabled={!editable}
                      maxLength={120}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          texts: draft.texts.map((t, i) =>
                            i === index ? { ...t, text: e.target.value } : t,
                          ),
                        })
                      }
                    />
                    <div className="flex gap-2">
                      <Input
                        aria-label="Font size"
                        type="number"
                        min={10}
                        max={48}
                        value={text.fontSize}
                        disabled={!editable}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            texts: draft.texts.map((t, i) =>
                              i === index ? { ...t, fontSize: Number(e.target.value) } : t,
                            ),
                          })
                        }
                      />
                      <Input
                        aria-label="Text color"
                        type="color"
                        value={text.color}
                        disabled={!editable}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            texts: draft.texts.map((t, i) =>
                              i === index ? { ...t, color: e.target.value } : t,
                            ),
                          })
                        }
                      />
                      <Button
                        variant="ghost"
                        disabled={!editable}
                        onClick={() =>
                          setDraft({ ...draft, texts: draft.texts.filter((_, i) => i !== index) })
                        }
                      >
                        Remove
                      </Button>
                    </div>
                    <BoxEditor
                      value={text}
                      disabled={!editable}
                      onChange={(box) =>
                        setDraft({
                          ...draft,
                          texts: draft.texts.map((t, i) => (i === index ? { ...t, ...box } : t)),
                        })
                      }
                    />
                  </div>
                ))}
                <Button
                  variant="outline"
                  disabled={!editable || draft.texts.length >= 4 || nextZ() > 15}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      texts: [
                        ...draft.texts,
                        {
                          id: crypto.randomUUID(),
                          text: "Live",
                          x: 16,
                          y: 16,
                          width: 300,
                          height: 60,
                          z: nextZ(),
                          fontSize: 24,
                          color: "#ffffff",
                          opacity: 1,
                        },
                      ],
                    })
                  }
                >
                  <Plus />
                  Text
                </Button>
              </div>
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Approved image overlays</h3>
                <Label htmlFor="mixer-overlay-file">PNG, up to 640×360 and 1 MiB</Label>
                <Input
                  id="mixer-overlay-file"
                  type="file"
                  accept="image/png"
                  disabled={!editable}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    if (file.size > 1048576 || file.type !== "image/png") {
                      setError("Choose a PNG up to 1 MiB.");
                      return;
                    }
                    try {
                      const dataBase64 = await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
                        reader.onerror = () => reject(new Error("File unavailable"));
                        reader.readAsDataURL(file);
                      });
                      const configuration = {
                        name: file.name,
                        contentType: "image/png" as const,
                        dataBase64,
                      };
                      await run(
                        "overlay",
                        configuration,
                        (key) =>
                          addMixerOverlayAction({
                            ...scope,
                            mixerId: mixer.id,
                            configuration,
                            idempotencyKey: key,
                          }),
                        () => undefined,
                      );
                    } catch {
                      setError("The image could not be read.");
                    }
                  }}
                />
                {mixer.overlays.map((overlay) => (
                  <div key={overlay.id} className="flex flex-wrap gap-2 text-sm">
                    <span>
                      {overlay.name} ({overlay.width}×{overlay.height})
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!editable || draft.overlays.length >= 4 || nextZ() > 15}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          overlays: [
                            ...draft.overlays,
                            {
                              overlayId: overlay.id,
                              x: 16,
                              y: 280,
                              width: Math.min(160, overlay.width),
                              height: Math.min(64, overlay.height),
                              z: nextZ(),
                              opacity: 1,
                            },
                          ],
                        })
                      }
                    >
                      Place in scene
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!canManage || pending}
                      onClick={() =>
                        void run(
                          "remove-overlay",
                          overlay.id,
                          (key) =>
                            removeMixerOverlayAction({
                              ...scope,
                              mixerId: mixer.id,
                              overlayId: overlay.id,
                              idempotencyKey: key,
                            }),
                          () => undefined,
                        )
                      }
                    >
                      Delete asset
                    </Button>
                  </div>
                ))}
                {draft.overlays.map((overlay, index) => (
                  <div key={`${overlay.overlayId}:${index}`} className="rounded-lg border p-3">
                    <BoxEditor
                      value={overlay}
                      disabled={!editable}
                      onChange={(box) =>
                        setDraft({
                          ...draft,
                          overlays: draft.overlays.map((o, i) =>
                            i === index ? { ...o, ...box } : o,
                          ),
                        })
                      }
                    />
                    <Button
                      variant="ghost"
                      disabled={!editable}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          overlays: draft.overlays.filter((_, i) => i !== index),
                        })
                      }
                    >
                      Remove from scene
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex gap-3">
                <Button
                  disabled={!editable}
                  onClick={() => {
                    const configuration = { version: sceneVersion, scene: draft };
                    void run(
                      "save-scene",
                      { sceneId, configuration },
                      (key) =>
                        saveMixerSceneAction({
                          ...scope,
                          mixerId: mixer.id,
                          sceneId,
                          configuration,
                          idempotencyKey: key,
                        }),
                      (scene) => {
                        setDraft(scene.scene);
                        setSceneVersion(scene.version);
                      },
                    );
                  }}
                >
                  Save draft
                </Button>
                <Button
                  variant="outline"
                  disabled={!editable || !sceneVersion || operation?.status === "pending"}
                  onClick={() => {
                    const configuration = { version: mixer.version, sceneId, sceneVersion };
                    void run(
                      "activate",
                      configuration,
                      (key) =>
                        activateMixerSceneAction({
                          ...scope,
                          mixerId: mixer.id,
                          configuration,
                          idempotencyKey: key,
                        }),
                      (result) => {
                        setMixer(result.mixer);
                        setOperation(result.operation);
                        operationId.current = result.operation.id;
                      },
                    );
                  }}
                >
                  Activate saved scene
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Activation uses the saved scene version. Unsaved edits stay in this draft.
              </p>
            </section>
            <section className="space-y-4 rounded-xl border p-4">
              <h2 className="font-medium">Program output</h2>
              <StreamPreview
                projectId={projectId}
                environmentId={environmentId}
                streamId={mixer.streamId}
              />
              <p className="text-sm">
                Applied scene: {mixer.appliedSceneId ?? "Waiting for activation"}; revision{" "}
                {mixer.appliedVersion}.
              </p>
              <p className="text-sm text-muted-foreground">
                {mixer.usage.renderSeconds.toFixed(1)} render seconds ·{" "}
                {mixer.usage.programSeconds.toFixed(1)} program seconds ·{" "}
                {mixer.usage.inputSeconds.toFixed(1)} reserved input seconds.
              </p>
              <p className="text-sm text-muted-foreground">
                Up to {mixer.limits.maxInputs} inputs. Studio canvas {mixer.limits.canvasWidth}×
                {mixer.limits.canvasHeight} at {mixer.limits.fps} fps; your stream profile controls
                delivery resolution. Missing sources use black video and silence. CPU overload uses
                a safe slate.
              </p>
              <p className="text-xs text-muted-foreground">
                First activation and stopping the mixer change the source generation and can briefly
                rebuffer playback. Scene changes within a running mixer preserve the program
                encoder.
              </p>
            </section>
          </div>
        </>
      )}
      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Create mixer</SheetTitle>
            <SheetDescription>
              Bind independent streams to this broadcast. Primary is the broadcast’s own source.
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-4 p-6">
            <p className="text-sm">Primary: {selectedBroadcast?.streamId}</p>
            {secondary.map((value, index) => (
              <SimpleSelect
                key={index}
                aria-label={`Additional source ${index + 1}`}
                value={value || "none"}
                options={[
                  { value: "none", label: "No additional source" },
                  ...streams
                    .filter((s) => s.id !== selectedBroadcast?.streamId)
                    .map((s) => ({ value: s.id, label: s.name })),
                ]}
                onValueChange={(value) =>
                  setSecondary((previous) =>
                    previous.map((v, i) => (i === index ? (value === "none" ? "" : value) : v)),
                  )
                }
              />
            ))}
            <p className="text-sm text-muted-foreground">
              This broadcast must be the only run using its program stream. Start its source and
              broadcast before activating a scene.
            </p>
            <Button
              disabled={pending}
              onClick={() => {
                const configuration = {
                  sources: secondary
                    .map((streamId, index) => ({ id: `source-${String(index + 1)}`, streamId }))
                    .filter((s) => s.streamId),
                };
                void run(
                  "create",
                  { broadcastId, configuration },
                  (key) =>
                    createMixerAction({
                      ...scope,
                      broadcastId,
                      configuration,
                      idempotencyKey: key,
                    }),
                  (m) => {
                    selected.current = m.id;
                    loaded.current = null;
                    setMixer(m);
                    setCreating(false);
                  },
                );
              }}
            >
              Create mixer
            </Button>
          </div>
        </SheetContent>
      </Sheet>
      <AlertDialog open={stopping} onOpenChange={setStopping}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop mixer?</AlertDialogTitle>
            <AlertDialogDescription>
              The stream returns to its primary source. Existing scenes stay saved; stopping
              releases mixer inputs and rendering.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setStopping(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending || !mixer}
              onClick={() => {
                if (!mixer) return;
                void run(
                  "stop",
                  { version: mixer.version },
                  (key) =>
                    stopMixerAction({
                      ...scope,
                      mixerId: mixer.id,
                      version: mixer.version,
                      idempotencyKey: key,
                    }),
                  (result) => {
                    setOperation(result.operation);
                    operationId.current = result.operation.id;
                    setStopping(false);
                  },
                );
              }}
            >
              Stop mixer
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
function BoxEditor({
  value,
  disabled,
  onChange,
}: {
  value: { x: number; y: number; width: number; height: number; z: number; opacity: number };
  disabled: boolean;
  onChange: (box: {
    x: number;
    y: number;
    width: number;
    height: number;
    z: number;
    opacity: number;
  }) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {(["x", "y", "width", "height", "z", "opacity"] as const).map((field) => (
        <Label key={field} className="text-xs text-muted-foreground">
          {field}
          <Input
            type="number"
            aria-label={field}
            step={field === "opacity" ? 0.1 : 1}
            disabled={disabled}
            value={value[field]}
            onChange={(e) => onChange({ ...value, [field]: Number(e.target.value) })}
          />
        </Label>
      ))}
    </div>
  );
}
function SceneDraft({ scene }: { scene: MixerScene }) {
  const layers = scene.layers.map((l, i) =>
    scene.layout === "custom"
      ? l
      : scene.layout === "single" || scene.layers.length === 1
        ? { ...l, x: 0, y: 0, width: 640, height: 360 }
        : scene.layout === "pip"
          ? i === 0
            ? { ...l, x: 0, y: 0, width: 640, height: 360 }
            : { ...l, x: 464, y: 254, width: 160, height: 90 }
          : {
              ...l,
              x: (i % 2) * 320,
              y: Math.floor(i / 2) * (scene.layers.length <= 2 ? 360 : 180),
              width: 320,
              height: scene.layers.length <= 2 ? 360 : 180,
            },
  );
  return (
    <div
      aria-label="Draft layout guide"
      className="relative aspect-video overflow-hidden rounded-lg border"
      style={{ background: scene.background }}
    >
      {[
        ...layers.map((l) => ({ ...l, label: l.sourceId })),
        ...scene.overlays.map((l) => ({ ...l, label: "Image overlay" })),
        ...scene.texts.map((l) => ({ ...l, label: l.text })),
      ].map((l, i) => (
        <div
          key={i}
          className="absolute flex items-center justify-center overflow-hidden border border-white/50 bg-slate-600/50 p-1 text-xs text-white"
          style={{
            left: `${l.x / 6.4}%`,
            top: `${l.y / 3.6}%`,
            width: `${l.width / 6.4}%`,
            height: `${l.height / 3.6}%`,
            zIndex: l.z,
            opacity: l.opacity,
          }}
        >
          <Layers className="mr-1 size-3" />
          {l.label}
        </div>
      ))}
    </div>
  );
}
