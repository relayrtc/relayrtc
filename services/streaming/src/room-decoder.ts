import type { EncoderInput } from "./encoder.js";

/** Room-only raw decoder. Each medium owns its inputs and can stall independently. */
export function roomDecoderArguments(
  input: EncoderInput,
  kind: "video" | "audio",
  width: number,
  height: number,
  fps: number,
  pixelFormat = "rgba",
) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...input.args.flatMap((value) =>
      value === "-i"
        ? ["-threads", "1", ...(kind === "video" ? ["-reinit_filter", "0"] : []), value]
        : [value],
    ),
  ];
  const filters: string[] = [];
  if (kind === "video") {
    const videos = input.video.slice(0, 4),
      columns = videos.length > 1 ? 2 : 1,
      rows = videos.length > 2 ? 2 : 1,
      tileWidth = Math.floor(width / columns / 2) * 2,
      tileHeight = Math.floor(height / rows / 2) * 2;
    for (const [i, video] of videos.entries())
      filters.push(
        // Normalize changing RTC dimensions before temporal filters. Rebuilding
        // setpts/fps resets their clock and can discard seconds of fresh frames.
        `[${video}]scale=${String(tileWidth)}:${String(tileHeight)}:force_original_aspect_ratio=decrease:eval=frame,pad=${String(tileWidth)}:${String(tileHeight)}:(ow-iw)/2:(oh-ih)/2:eval=frame,setsar=1,format=${pixelFormat},setpts=PTS-STARTPTS,fps=${String(fps)}[v${String(i)}]`,
      );
    if (videos.length === 1) filters.push("[v0]null[out]");
    else
      filters.push(
        `${videos.map((_, i) => `[v${String(i)}]`).join("")}xstack=inputs=${String(videos.length)}:layout=${videos.map((_, i) => `${String((i % columns) * tileWidth)}_${String(Math.floor(i / columns) * tileHeight)}`).join("|")}:fill=black:shortest=0,pad=${String(width)}:${String(height)}:0:0[out]`,
      );
    args.push(
      "-filter_complex_threads",
      "1",
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[out]",
      "-fps_mode",
      "passthrough",
      "-threads",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      pixelFormat,
      "pipe:1",
    );
  } else {
    for (const [i, audio] of input.audio.entries())
      filters.push(
        `[${audio}]asetpts=PTS-STARTPTS,aresample=48000:async=1000:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo[a${String(i)}]`,
      );
    filters.push(
      `${input.audio.map((_, i) => `[a${String(i)}]`).join("")}amix=inputs=${String(input.audio.length)}:duration=longest:dropout_transition=0:normalize=1[out]`,
    );
    args.push(
      "-filter_complex_threads",
      "1",
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[out]",
      "-threads",
      "1",
      "-f",
      "s16le",
      "-ac",
      "2",
      "-ar",
      "48000",
      "pipe:1",
    );
  }
  return args;
}
