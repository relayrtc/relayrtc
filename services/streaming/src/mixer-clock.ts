/** Raw inputs count frames/samples, so skipped timer callbacks must not lose time. */
export function dueMixerFrames(elapsedMs: number, submitted: number, fps: number) {
  return Math.max(
    0,
    Math.min(Math.ceil(fps / 4), Math.floor((elapsedMs * fps) / 1000) - submitted),
  );
}
