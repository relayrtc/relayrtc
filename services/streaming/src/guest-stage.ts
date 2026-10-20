import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { roomInput, type EncoderInput, type ExportTrack } from "./encoder.js";
import { mixerSceneSchema } from "@relayrtc/validation";
const responseSchema = z.object({
  layout: z.enum(["grid", "single", "pip"]).default("grid"),
  revision: z.number().default(1),
  tracks: z
    .array(
      z.object({
        id: z.string(),
        sourceId: z.string(),
        kind: z.enum(["audio", "video"]),
        trackType: z.string(),
        codec: z.string(),
        sdp: z.string(),
      }),
    )
    .max(12),
});
/** The stage shares the mixer clock/decoder bounds; only the source subscriptions change. */
export function createGuestStageControl(
  directory: string,
  load: () => Promise<unknown>,
  advanced?: () => Promise<unknown>,
) {
  const inputs = new Map<string, EncoderInput>();
  const slots = new Map<string, number>();
  let revision = 0,
    signature = "";
  return {
    inputForSource: (sourceId: string) => inputs.get(sourceId),
    sourceInfo: () => ({
      tracks: [...inputs.values()].flatMap((input) => input.sourceInfo.tracks),
    }),
    control: async () => {
      const value = responseSchema.parse(await load()),
        groups = new Map<string, ExportTrack[]>();
      for (const track of value.tracks) {
        const group = groups.get(track.sourceId) ?? [];
        group.push(track);
        groups.set(track.sourceId, group);
      }
      inputs.clear();
      if (advanced) {
        inputs.set("primary", await roomInput(value.tracks, directory));
        return advanced();
      }
      const sources = [...groups.entries()].slice(0, 4);
      for (const key of slots.keys()) if (!groups.has(key)) slots.delete(key);
      for (const [sourceId, tracks] of sources) {
        let slot = slots.get(sourceId);
        if (slot === undefined) {
          slot = [0, 1, 2, 3].find((i) => ![...slots.values()].includes(i));
          if (slot === undefined) continue;
          slots.set(sourceId, slot);
        }
        const path = join(directory, `guest-source-${String(slot)}`);
        await mkdir(path, { recursive: true });
        inputs.set(sourceId, await roomInput(tracks, path));
      }
      const nextSignature = JSON.stringify([
        value.revision,
        sources.map(([key, tracks]) => [key, tracks.map((t) => t.id)]),
      ]);
      if (signature !== nextSignature) {
        signature = nextSignature;
        revision++;
      }
      const visible =
        value.layout === "single"
          ? sources.slice(0, 1)
          : value.layout === "pip"
            ? sources.slice(0, 2)
            : sources;
      const scene = mixerSceneSchema.parse({
        name: "Live guest stage",
        layout: value.layout,
        background: "#101010",
        layers: visible.map(([sourceId], i) => ({
          sourceId,
          x: 0,
          y: 0,
          width: 640,
          height: 360,
          z: i,
          fit: "contain",
          opacity: 1,
        })),
        audio: sources.map(([sourceId]) => ({ sourceId, gainDb: 0, muted: false })),
        overlays: [],
        texts: [],
        ducking: null,
        transition: "cut",
      });
      return {
        mixer: {
          id: "guest-stage",
          revision,
          sceneId: "guest-stage",
          scene,
          primaryUrl: "",
          sources: sources.map(([id, tracks]) => ({
            id,
            streamId: "guest-stage",
            audioOnly: !tracks.some((t) => t.kind === "video"),
          })),
        },
      };
    },
  };
}
