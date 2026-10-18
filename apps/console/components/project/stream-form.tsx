"use client";
import { Radio, Video, Waves } from "lucide-react";
import { StreamFieldSection } from "./stream-ui";
import { cn } from "@/lib/utils";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getRoomAction, listRoomsAction } from "@/actions/rooms";
import type { ConsoleRoom, RoomListCursor } from "@/lib/rooms/contracts";
import { saveStreamAction } from "@/actions/streaming";
import { RestreamSourcePicker } from "./restream-source-picker";
import { SimpleSelect } from "@/components/page/simple-select";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  streamQualityPresets,
  matchingQualityPreset,
  encodingFromPreset,
  type StreamEncoding,
} from "@/lib/streaming/quality-presets";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import type { ConsoleStream } from "@/lib/streaming/contracts";
export function StreamForm({
  stream,
  projectId,
  environmentId,
  onSaved,
}: {
  stream: ConsoleStream | null;
  projectId: string;
  environmentId: string;
  onSaved: (stream: ConsoleStream) => void;
}) {
  const pathname = usePathname();
  const initialRoomId = stream?.source.kind === "room" ? stream.source.roomId : "";
  const [kind, setKind] = useState(stream?.source.kind ?? "rtmp");
  const [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false);
  const key = useRef(crypto.randomUUID());
  const [profile, setProfile] = useState<StreamEncoding>(
    stream?.profile ?? encodingFromPreset(streamQualityPresets[2]),
  );
  const [preset, setPreset] = useState<string>(
    stream ? matchingQualityPreset(stream.profile) : "720p",
  );
  const [layout, setLayout] = useState(stream?.profile.layout ?? "single");
  const totalBitrate = (profile.audioOnly ? 0 : profile.videoBitrate) + profile.audioBitrate;
  const selectedPreset = streamQualityPresets.find((p) => p.id === preset);
  const [roomId, setRoomId] = useState(stream?.source.kind === "room" ? stream.source.roomId : "");
  const [rooms, setRooms] = useState<ConsoleRoom[]>([]),
    [roomCursor, setRoomCursor] = useState<RoomListCursor | null>(null),
    [roomsLoading, setRoomsLoading] = useState(kind === "room");
  useEffect(() => {
    if (kind !== "room") return;
    let active = true;
    void Promise.all([
      listRoomsAction({ projectId, environmentId }),
      initialRoomId
        ? getRoomAction({ projectId, environmentId, roomId: initialRoomId })
        : Promise.resolve(null),
    ])
      .then(([result, existing]) => {
        if (!active) return;
        if (result.error) setError(result.error.description);
        else {
          const available = result.data.rooms.filter(
            (r) => r.status === "created" || r.status === "active",
          );
          setRooms([
            ...new Map(
              [
                ...(existing?.data && ["created", "active"].includes(existing.data.status)
                  ? [existing.data]
                  : []),
                ...available,
              ].map((r) => [r.id, r]),
            ).values(),
          ]);
          setRoomCursor(result.data.nextCursor);
        }
      })
      .catch(() => {
        if (active) setError("Rooms are unavailable. Reopen this form to retry.");
      })
      .finally(() => {
        if (active) setRoomsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, environmentId, kind, initialRoomId]);
  const moreRooms = async () => {
    if (!roomCursor) return;
    setRoomsLoading(true);
    try {
      const result = await listRoomsAction({ projectId, environmentId, cursor: roomCursor });
      if (result.error) setError(result.error.description);
      else {
        setRooms((previous) => [
          ...new Map(
            [
              ...previous,
              ...result.data.rooms.filter((r) => r.status === "created" || r.status === "active"),
            ].map((r) => [r.id, r]),
          ).values(),
        ]);
        setRoomCursor(result.data.nextCursor);
      }
    } catch {
      setError("Could not load more rooms. Try again.");
    } finally {
      setRoomsLoading(false);
    }
  };
  return (
    <form
      className="space-y-5 [&_input]:rounded-lg [&_button]:rounded-lg"
      onChange={() => {
        key.current = crypto.randomUUID();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (kind === "room" && !rooms.some((r) => r.id === roomId)) {
          setError("Choose an available room in this environment.");
          return;
        }
        const form = new FormData(event.currentTarget);
        const number = (name: string) => Number(form.get(name));
        const ids = (name: string) =>
          String(form.get(name) ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
        const configuration = {
          name: String(form.get("name")),
          source:
            kind === "room"
              ? {
                  kind,
                  roomId: String(form.get("roomId")),
                  videoTrackIds: ids("videoTrackIds"),
                  audioTrackIds: ids("audioTrackIds"),
                }
              : { kind },
          profile: { ...profile, layout },
          maxDurationSeconds: number("maxDurationSeconds"),
          retentionSeconds: number("retentionSeconds"),
          ...(stream ? { version: stream.version } : {}),
        };
        setPending(true);
        void saveStreamAction({
          projectId,
          environmentId,
          configuration,
          ...(stream ? { streamId: stream.id } : {}),
          idempotencyKey: key.current,
        })
          .then((result) => {
            if (result.error) setError(result.error.description);
            else onSaved(result.data);
          })
          .catch(() => setError("Save failed. Retry or refresh the current configuration."))
          .finally(() => setPending(false));
      }}
    >
      <fieldset disabled={pending} className="grid min-w-0 items-start gap-5 lg:grid-cols-2">
        <div className="min-w-0 space-y-5">
          <StreamFieldSection
            title="Stream details"
            description="Use a name that is easy to recognize in your workspace."
          >
            <div className="grid gap-2">
              <Label htmlFor="stream-name">Name</Label>
              <Input
                id="stream-name"
                name="name"
                placeholder="My live stream"
                required
                maxLength={120}
                defaultValue={stream?.name}
              />
            </div>
            {stream && stream.source.kind !== "room" && (
              <RestreamSourcePicker
                projectId={projectId}
                environmentId={environmentId}
                streamId={stream.id}
                canManage={true}
              />
            )}
          </StreamFieldSection>
          <StreamFieldSection
            title="Output quality"
            description="Choose the quality your viewers receive."
          >
            {" "}
            <div className="space-y-2">
              <div className="grid gap-2">
                <Label htmlFor="stream-quality">Quality preset</Label>
                <SimpleSelect
                  id="stream-quality"
                  className="w-full sm:w-full"
                  value={preset}
                  options={[
                    ...streamQualityPresets.map((p) => ({ value: p.id, label: p.label })),
                    { value: "custom", label: "Custom quality settings" },
                  ]}
                  onValueChange={(value) => {
                    key.current = crypto.randomUUID();
                    setPreset(value);
                    const selected = streamQualityPresets.find((p) => p.id === value);
                    if (selected) setProfile(encodingFromPreset(selected));
                  }}
                />
              </div>
            </div>
            <Card size="sm" className="rounded-lg bg-background/50 ring-0">
              <CardHeader>
                <CardTitle>{selectedPreset?.label ?? "Custom quality"}</CardTitle>
                <CardDescription>
                  {selectedPreset?.description ?? "Choose resolution, FPS and bitrate below."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {!profile.audioOnly && (
                    <Badge variant="secondary">
                      {profile.width} x {profile.height} / {profile.fps} FPS
                    </Badge>
                  )}
                  <Badge variant="outline">
                    {(totalBitrate / 1000000).toFixed(2)} Mbit/s target
                  </Badge>
                </div>
                <p className="text-sm">
                  {!profile.audioOnly && (
                    <>Video: {Math.round(profile.videoBitrate / 1000)} kbit/s. </>
                  )}
                  Audio: {Math.round(profile.audioBitrate / 1000)} kbit/s.
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  About {((totalBitrate * 3600) / 8 / 1000000000).toFixed(2)} GB per hour of program
                  media, per viewer, before network overhead. Higher bitrate uses more bandwidth.
                  These are output targets; actual traffic depends on source and encoding.
                </p>
              </CardContent>
            </Card>
            {preset === "custom" && (
              <Card size="sm" className="rounded-lg bg-background/50 ring-0">
                <CardHeader>
                  <CardTitle>Custom encoding</CardTitle>
                  <CardDescription>
                    Supported frame rate: 15 to 30 FPS. 1000 kbit/s equals 1 Mbit/s.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Label className="justify-between">
                    Audio only
                    <Switch
                      checked={profile.audioOnly}
                      onCheckedChange={(checked) => {
                        key.current = crypto.randomUUID();
                        setProfile((previous) => ({ ...previous, audioOnly: checked }));
                      }}
                    />
                  </Label>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {(
                      [
                        ["width", "Width (pixels)", 320, 1920, 2, 1],
                        ["height", "Height (pixels)", 180, 1080, 2, 1],
                        ["fps", "Frames per second", 15, 30, 1, 1],
                        ["videoBitrate", "Video bitrate (kbit/s)", 200, 6000, 1, 1000],
                        ["audioBitrate", "Audio bitrate (kbit/s)", 64, 192, 1, 1000],
                      ] as const
                    ).map(([field, label, min, max, step, scale]) => (
                      <div key={field} className="space-y-2">
                        <Label htmlFor={`stream-${field}`}>{label}</Label>
                        <Input
                          id={`stream-${field}`}
                          type="number"
                          required
                          min={min}
                          max={max}
                          step={step}
                          disabled={profile.audioOnly && field !== "audioBitrate"}
                          value={profile[field] / scale}
                          onChange={(event) => {
                            key.current = crypto.randomUUID();
                            setProfile((previous) => ({
                              ...previous,
                              [field]: Number(event.target.value) * scale,
                            }));
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </StreamFieldSection>
        </div>
        <div className="min-w-0 space-y-5">
          <StreamFieldSection
            title="Source type"
            description="Choose how audio and video enter your stream."
          >
            <div role="radiogroup" aria-label="Source type" className="space-y-3">
              {[
                {
                  value: "rtmp",
                  label: "RTMP",
                  description: "OBS, Streamlabs or any RTMP encoder",
                  icon: Radio,
                },
                {
                  value: "whip",
                  label: "WHIP",
                  description: "A WebRTC encoder using a WHIP endpoint",
                  icon: Waves,
                },
                {
                  value: "room",
                  label: "WebRTC room",
                  description: "Camera, microphone and screen tracks from your app",
                  icon: Video,
                },
              ].map(({ value, label, description, icon: Icon }) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                    kind === value
                      ? "border-blue-500/60 bg-blue-500/5"
                      : "border-border/70 hover:bg-muted/50",
                  )}
                >
                  <Icon
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      kind === value ? "text-blue-500" : "text-muted-foreground",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                      {description}
                    </span>
                  </span>
                  <input
                    type="radio"
                    name="sourceType"
                    aria-label={label}
                    value={value}
                    checked={kind === value}
                    onChange={() => {
                      setKind(value as typeof kind);
                      if (value === "room" && kind !== "room") setRoomsLoading(true);
                      key.current = crypto.randomUUID();
                    }}
                    className="mt-1 size-3.5 shrink-0 accent-blue-500"
                  />
                </label>
              ))}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {kind === "rtmp"
                ? "Generate your server URL and stream key from Overview after saving. To pull an HLS feed, add it from the Source library after creating this RTMP stream."
                : kind === "room"
                  ? "Choose a room in this environment. Your application must join and publish media before you start the source."
                  : "Generate a WHIP endpoint and bearer token from Overview after saving."}
            </p>
            {kind === "room" && (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="stream-room">RTC room</Label>
                  <SimpleSelect
                    className="w-full sm:w-full"
                    id="stream-room"
                    value={roomId}
                    placeholder={roomsLoading ? "Loading rooms..." : "Choose an existing room"}
                    disabled={pending || roomsLoading}
                    options={[
                      ...rooms.map((r) => ({
                        value: r.id,
                        label: `${r.name || "Unnamed room"} (${r.maxParticipants} seats)`,
                      })),
                    ]}
                    onValueChange={(value) => {
                      setRoomId(value);
                      key.current = crypto.randomUUID();
                    }}
                  />
                </div>
                <input type="hidden" name="roomId" value={roomId} />
                {roomCursor && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={roomsLoading}
                    onClick={() => void moreRooms()}
                  >
                    Load more rooms
                  </Button>
                )}
                {!roomsLoading && !rooms.length && (
                  <p className="text-sm text-muted-foreground">
                    Create a room in this project first, then choose it here.
                  </p>
                )}
                <Link
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  href={`${pathname.split("/streams")[0]}/rooms?environmentId=${encodeURIComponent(environmentId)}`}
                >
                  Manage rooms
                </Link>
                <Accordion className="space-y-3">
                  <AccordionItem value="section-1">
                    <AccordionTrigger>Advanced track selection</AccordionTrigger>
                    <AccordionContent keepMounted className="space-y-4 pt-2">
                      {(["videoTrackIds", "audioTrackIds"] as const).map((name) => (
                        <div key={name}>
                          <Label htmlFor={name}>
                            {name === "videoTrackIds" ? "Video track IDs" : "Audio track IDs"}{" "}
                            (comma separated, optional)
                          </Label>
                          <Input
                            id={name}
                            name={name}
                            defaultValue={
                              stream?.source.kind === "room" ? stream.source[name].join(",") : ""
                            }
                          />
                        </div>
                      ))}
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </>
            )}
          </StreamFieldSection>
          <Accordion className="space-y-4 rounded-xl border border-border/70 bg-card/30 p-4">
            <AccordionItem value="section-2">
              <AccordionTrigger>Layout and timing</AccordionTrigger>
              <AccordionContent keepMounted className="space-y-4 pt-2">
                <div className="grid gap-2">
                  <Label htmlFor="stream-layout">Layout</Label>
                  <SimpleSelect
                    id="stream-layout"
                    value={layout}
                    className="w-full sm:w-full"
                    options={[
                      { value: "single", label: "Single speaker" },
                      { value: "grid", label: "Grid" },
                    ]}
                    onValueChange={(value) => {
                      if (value === "single" || value === "grid") {
                        setLayout(value);
                        key.current = crypto.randomUUID();
                      }
                    }}
                  />
                </div>
                {(
                  [
                    [
                      "maxDurationSeconds",
                      "Maximum source duration (seconds)",
                      stream?.maxDurationSeconds ?? 14400,
                      60,
                      86400,
                      1,
                    ],
                    [
                      "retentionSeconds",
                      "Live media retention (seconds)",
                      stream?.retentionSeconds ?? 300,
                      60,
                      86400,
                      1,
                    ],
                  ] as const
                ).map(([name, label, value, min, max, step]) => (
                  <div key={name}>
                    <Label htmlFor={`stream-${name}`}>{label}</Label>
                    <Input
                      id={`stream-${name}`}
                      name={name}
                      type="number"
                      required
                      min={min}
                      max={max}
                      step={step}
                      defaultValue={value}
                    />
                  </div>
                ))}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
        <div className="flex flex-col items-start gap-4 border-t border-border/70 pt-5 lg:col-span-2">
          {" "}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            type="submit"
            className="w-full sm:w-auto"
            disabled={pending || (kind === "room" && !rooms.some((r) => r.id === roomId))}
          >
            {pending ? "Saving…" : stream ? "Save changes" : "Create stream"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Saving a stream does not start a broadcast. Connect your source and prepare a broadcast
            from Overview.
          </p>
        </div>
      </fieldset>
    </form>
  );
}
