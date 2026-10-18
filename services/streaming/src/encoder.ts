import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StreamProfile } from "@relayrtc/types";
import { z } from "zod";
import { streamSourceInfoSchema } from "@relayrtc/validation";

export interface ExportTrack {
  id: string;
  kind: "audio" | "video";
  trackType: string;
  codec: string;
  sdp: string;
}
export interface EncoderInput {
  args: string[];
  video: string[];
  audio: string[];
  sourceInfo: z.infer<typeof streamSourceInfoSchema>;
}
function encoderDiagnostic(text: string, urls: readonly string[]) {
  let safe = text;
  for (const value of urls) {
    try {
      const url = new URL(value);
      safe = safe.replaceAll(value, "[redacted URL]");
      const secrets = [decodeURIComponent(url.password), ...url.searchParams.values()];
      for (const secret of secrets)
        if (secret.length >= 16) safe = safe.replaceAll(secret, "[redacted credential]");
    } catch {
      /* Most encoder arguments are not URLs. */
    }
  }
  return safe
    .replace(/(?:rtsps?|rtmps?|https?):\/\/[^\s"'<>]+/giu, "[redacted URL]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/giu, "[redacted authorization]")
    .slice(0, 2000)
    .trim();
}
export async function roomInput(tracks: ExportTrack[], directory: string): Promise<EncoderInput> {
  const result: EncoderInput = {
    args: [],
    video: [],
    audio: [],
    sourceInfo: streamSourceInfoSchema.parse({
      tracks: tracks.map((track) => ({ kind: track.kind, codec: track.codec, trackId: track.id })),
    }),
  };
  for (const [index, track] of tracks.entries()) {
    const file = join(directory, `track-${String(index)}.sdp`);
    await writeFile(file, track.sdp, { mode: 0o600 });
    result.args.push(
      "-thread_queue_size",
      "512",
      "-protocol_whitelist",
      "file,udp,rtp",
      "-fflags",
      "+genpts+discardcorrupt",
      "-analyzeduration",
      "1000000",
      "-probesize",
      "1000000",
      "-i",
      file,
    );
    result[track.kind].push(`${String(index)}:${track.kind === "video" ? "v" : "a"}:0`);
  }
  return result;
}
export async function externalInput(
  url: string,
  ffprobe: string,
  signal: AbortSignal,
): Promise<EncoderInput> {
  const childEnvironment = { PATH: process.env.PATH };
  const output = await new Promise<string>((resolve, reject) => {
    const process = spawn(
      ffprobe,
      [
        "-v",
        "error",
        "-rtsp_transport",
        "tcp",
        "-timeout",
        "10000000",
        "-analyzeduration",
        "2000000",
        "-probesize",
        "2000000",
        "-show_streams",
        "-of",
        "json",
        url,
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        signal,
        env: childEnvironment,
      },
    );
    let data = "";
    let diagnostic = "";
    process.stderr.on("data", (chunk: Buffer) => {
      diagnostic += chunk.toString().slice(0, Math.max(0, 8192 - diagnostic.length));
    });
    const timer = setTimeout(() => process.kill("SIGKILL"), 12000);
    process.stdout.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 262144) process.kill("SIGKILL");
    });
    process.on("error", reject);
    process.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(data);
      else reject(new Error(`SOURCE_UNAVAILABLE: ${encoderDiagnostic(diagnostic, [url])}`));
    });
  });
  const parsed = z
    .object({
      streams: z.array(
        z.object({
          index: z.number().int(),
          codec_type: z.string(),
          codec_name: z.string().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
        }),
      ),
    })
    .parse(JSON.parse(output));
  const video = parsed.streams.find((s) => s.codec_type === "video"),
    audio = parsed.streams.find((s) => s.codec_type === "audio");
  if (
    video &&
    (!["h264", "vp8", "vp9"].includes(video.codec_name ?? "") ||
      (video.width ?? 0) > 3840 ||
      (video.height ?? 0) > 2160)
  )
    throw new Error("SOURCE_UNAVAILABLE");
  if (audio && !["aac", "opus", "mp3"].includes(audio.codec_name ?? ""))
    throw new Error("SOURCE_UNAVAILABLE");
  if (!video && !audio) throw new Error("SOURCE_UNAVAILABLE");
  return {
    args: [
      "-thread_queue_size",
      "512",
      "-rtsp_transport",
      "tcp",
      "-timeout",
      "10000000",
      "-fflags",
      "+genpts+discardcorrupt",
      "-i",
      url,
    ],
    video: video ? [`0:${String(video.index)}`] : [],
    audio: audio ? [`0:${String(audio.index)}`] : [],
    sourceInfo: streamSourceInfoSchema.parse({
      tracks: [
        ...(video
          ? [{ kind: "video", codec: video.codec_name, width: video.width, height: video.height }]
          : []),
        ...(audio ? [{ kind: "audio", codec: audio.codec_name }] : []),
      ],
    }),
  };
}
export function encoderArguments(
  input: EncoderInput,
  profile: StreamProfile,
  output: string,
  maxDuration: number,
) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...input.args];
  const filters: string[] = [];
  const videos = profile.audioOnly ? [] : input.video.slice(0, profile.layout === "single" ? 1 : 4);
  // Fixed program clock and format across every accepted source codec.
  if (!profile.audioOnly) {
    const columns = videos.length > 1 ? 2 : 1,
      rows = videos.length > 2 ? 2 : 1;
    const width = Math.floor(profile.width / columns / 2) * 2,
      height = Math.floor(profile.height / rows / 2) * 2;
    if (videos.length === 0)
      filters.push(
        `color=c=black:s=${String(profile.width)}x${String(profile.height)}:r=${String(profile.fps)},format=yuv420p[vout]`,
      );
    else {
      for (const [index, video] of videos.entries())
        filters.push(
          `[${video}]setpts=PTS-STARTPTS,fps=${String(profile.fps)},scale=${String(width)}:${String(height)}:force_original_aspect_ratio=decrease,pad=${String(width)}:${String(height)}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${String(index)}]`,
        );
      if (videos.length === 1) filters.push("[v0]null[vout]");
      else {
        const layout = videos
          .map(
            (_v, i) =>
              `${String((i % columns) * width)}_${String(Math.floor(i / columns) * height)}`,
          )
          .join("|");
        filters.push(
          `${videos.map((_v, i) => `[v${String(i)}]`).join("")}xstack=inputs=${String(videos.length)}:layout=${layout}:fill=black:shortest=0,pad=${String(profile.width)}:${String(profile.height)}:0:0[vout]`,
        );
      }
    }
  }
  const audios = input.audio.slice(0, 8);
  if (audios.length === 0) filters.push("anullsrc=r=48000:cl=stereo[aout]");
  else {
    for (const [index, audio] of audios.entries())
      filters.push(
        `[${audio}]asetpts=PTS-STARTPTS,aresample=48000:async=1000:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo[a${String(index)}]`,
      );
    filters.push(
      `${audios.map((_a, i) => `[a${String(i)}]`).join("")}amix=inputs=${String(audios.length)}:duration=longest:dropout_transition=2:normalize=1,alimiter=limit=0.95[aout]`,
    );
  }
  args.push("-filter_complex_threads", "2", "-filter_complex", filters.join(";"));
  if (!profile.audioOnly)
    args.push(
      "-map",
      "[vout]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "main",
      "-pix_fmt",
      "yuv420p",
      "-b:v",
      String(profile.videoBitrate),
      "-maxrate",
      String(profile.videoBitrate),
      "-bufsize",
      String(profile.videoBitrate * 2),
      "-g",
      String(profile.fps * 2),
      "-keyint_min",
      String(profile.fps * 2),
      "-sc_threshold",
      "0",
      "-force_key_frames",
      "expr:gte(t,n_forced*2)",
    );
  args.push(
    "-map",
    "[aout]",
    "-c:a",
    "aac",
    "-b:a",
    String(profile.audioBitrate),
    "-ar",
    "48000",
    "-ac",
    "2",
    "-threads",
    "2",
    "-t",
    String(maxDuration),
    "-f",
    "rtsp",
    "-rtsp_transport",
    "tcp",
    output,
  );
  return args;
}
export function startEncoder(binary: string, args: string[], signal: AbortSignal): ChildProcess {
  const child = spawn(binary, args, {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH },
    signal,
  });
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic += chunk.toString().slice(0, Math.max(0, 8192 - diagnostic.length));
  });
  child.once("close", (code) => {
    if (code !== 0 && !signal.aborted)
      process.stderr.write(
        `Streaming encoder exited (${String(code)}): ${encoderDiagnostic(diagnostic, args)}\n`,
      );
  });
  return child;
}
export async function stopEncoder(process: ChildProcess | undefined) {
  if (process?.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => process.kill("SIGKILL"), 3000);
    process.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    process.kill("SIGTERM");
  });
}
