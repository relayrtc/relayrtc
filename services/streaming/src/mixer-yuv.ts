import type { Raster } from "./mixer-canvas.js";

/** Opaque room tiles stay in the encoder's native format: 1.5 bytes per pixel. */
export function solidYuv(color: string, width: number, height: number): Raster {
  const r = Number.parseInt(color.slice(1, 3), 16),
    g = Number.parseInt(color.slice(3, 5), 16),
    b = Number.parseInt(color.slice(5, 7), 16),
    pixels = Buffer.alloc((width * height * 3) / 2);
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  pixels.fill(clamp(16 + 0.257 * r + 0.504 * g + 0.098 * b), 0, width * height);
  pixels.fill(
    clamp(128 - 0.148 * r - 0.291 * g + 0.439 * b),
    width * height,
    (width * height * 5) / 4,
  );
  pixels.fill(clamp(128 + 0.439 * r - 0.368 * g - 0.071 * b), (width * height * 5) / 4);
  return { width, height, pixels, opaque: true };
}

/** Decoders size tiles before transport; ordinary composition only copies rows. */
export function blitYuv(
  target: Buffer,
  image: Raster,
  box: { x: number; y: number; width: number; height: number },
  targetWidth: number,
  targetHeight: number,
) {
  let sourceOffset = 0,
    targetOffset = 0;
  for (let plane = 0; plane < 3; plane++) {
    const divisor = plane === 0 ? 1 : 2;
    const sw = image.width / divisor,
      sh = image.height / divisor,
      tw = targetWidth / divisor,
      th = targetHeight / divisor,
      bx = Math.floor(box.x / divisor),
      by = Math.floor(box.y / divisor),
      bw = Math.floor(box.width / divisor),
      bh = Math.floor(box.height / divisor);
    for (let y = 0; y < bh && by + y < th; y++) {
      if (by + y < 0) continue;
      const sy = Math.floor((y * sh) / bh),
        to = targetOffset + (by + y) * tw + bx;
      if (sw === bw && bx >= 0 && bx + bw <= tw)
        image.pixels.copy(target, to, sourceOffset + sy * sw, sourceOffset + sy * sw + bw);
      else
        for (let x = 0; x < bw && bx + x < tw; x++)
          if (bx + x >= 0)
            target[to + x] = image.pixels[sourceOffset + sy * sw + Math.floor((x * sw) / bw)] ?? 0;
    }
    sourceOffset += sw * sh;
    targetOffset += tw * th;
  }
}
