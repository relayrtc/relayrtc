import type { MixerScene, MixerLayer } from "@relayrtc/types";
export interface Raster {
  width: number;
  height: number;
  pixels: Buffer;
}
export const CANVAS_WIDTH = 640,
  CANVAS_HEIGHT = 360,
  MIXER_FPS = 15,
  PCM_BYTES = 12800;
export function sceneLayers(scene: MixerScene): MixerLayer[] {
  return scene.layers.map((l, i) => {
    if (scene.layout === "custom") return l;
    if (scene.layout === "single" || scene.layers.length === 1)
      return { ...l, x: 0, y: 0, width: 640, height: 360 };
    if (scene.layout === "pip")
      return i === 0
        ? { ...l, x: 0, y: 0, width: 640, height: 360 }
        : { ...l, x: 464, y: 254, width: 160, height: 90 };
    const columns = 2,
      rows = scene.layers.length <= 2 ? 1 : 2;
    return {
      ...l,
      x: (i % columns) * 320,
      y: Math.floor(i / columns) * (360 / rows),
      width: 320,
      height: 360 / rows,
    };
  });
}
export function solid(color: string, width = 640, height = 360): Raster {
  const pixels = Buffer.alloc(width * height * 4),
    r = Number.parseInt(color.slice(1, 3), 16),
    g = Number.parseInt(color.slice(3, 5), 16),
    b = Number.parseInt(color.slice(5, 7), 16);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = 255;
  }
  return { pixels, width, height };
}
/** A bounded nearest-neighbour compositor; callers admit only fixed-size decoded rasters. */
export function blit(
  target: Buffer,
  image: Raster,
  box: { x: number; y: number; width: number; height: number; opacity: number },
  fit: "contain" | "cover" = "contain",
) {
  const ratio =
    fit === "cover"
      ? Math.max(box.width / image.width, box.height / image.height)
      : Math.min(box.width / image.width, box.height / image.height);
  const scaledW = image.width * ratio,
    scaledH = image.height * ratio,
    offsetX = (box.width - scaledW) / 2,
    offsetY = (box.height - scaledH) / 2;
  for (let y = 0; y < box.height; y++)
    for (let x = 0; x < box.width; x++) {
      const sx = Math.floor((x - offsetX) / ratio),
        sy = Math.floor((y - offsetY) / ratio);
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
      const from = (sy * image.width + sx) * 4,
        to = ((box.y + y) * 640 + box.x + x) * 4,
        alpha = (Number(image.pixels[from + 3]) / 255) * box.opacity;
      if (alpha === 0) continue;
      for (let c = 0; c < 3; c++)
        target[to + c] = Math.round(
          Number(image.pixels[from + c]) * alpha + Number(target[to + c]) * (1 - alpha),
        );
    }
}
export function mixAudio(scene: MixerScene, blocks: Map<string, Buffer>, previousDuck: number) {
  const output = Buffer.alloc(PCM_BYTES),
    dominant = scene.ducking ? blocks.get(scene.ducking.sourceId) : undefined;
  let rms = 0;
  if (dominant) {
    for (let i = 0; i < dominant.length; i += 2) rms += (dominant.readInt16LE(i) / 32768) ** 2;
    rms = Math.sqrt(rms / (dominant.length / 2));
  }
  const target =
    scene.ducking && rms >= scene.ducking.threshold ? 10 ** (-scene.ducking.attenuationDb / 20) : 1;
  const duck = previousDuck + (target - previousDuck) * (target < previousDuck ? 0.75 : 0.2);
  const active = scene.audio.filter((a) => !a.muted && blocks.has(a.sourceId));
  for (let i = 0; i < PCM_BYTES; i += 2) {
    let value = 0;
    for (const a of active) {
      const block = blocks.get(a.sourceId);
      if (block)
        value +=
          block.readInt16LE(i) *
          10 ** (a.gainDb / 20) *
          (a.sourceId === scene.ducking?.sourceId ? 1 : duck);
    }
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i);
  }
  return { output, duck };
}
