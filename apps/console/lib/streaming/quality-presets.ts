import type { ConsoleStream } from "./contracts";

export const streamQualityPresets = [
  {
    id: "economy",
    label: "480p · 15 FPS",
    description: "Lower bandwidth for talks and mostly static video.",
    audioOnly: false,
    width: 854,
    height: 480,
    fps: 15,
    videoBitrate: 700000,
    audioBitrate: 64000,
  },
  {
    id: "480p",
    label: "480p · 30 FPS",
    description: "Standard definition with smoother motion.",
    audioOnly: false,
    width: 854,
    height: 480,
    fps: 30,
    videoBitrate: 1200000,
    audioBitrate: 96000,
  },
  {
    id: "720p",
    label: "720p · 30 FPS (recommended)",
    description: "HD quality with a moderate bandwidth target.",
    audioOnly: false,
    width: 1280,
    height: 720,
    fps: 30,
    videoBitrate: 2500000,
    audioBitrate: 128000,
  },
  {
    id: "1080p",
    label: "1080p · 30 FPS",
    description: "Full HD for a sharper picture and more bandwidth.",
    audioOnly: false,
    width: 1920,
    height: 1080,
    fps: 30,
    videoBitrate: 5000000,
    audioBitrate: 128000,
  },
  {
    id: "audio",
    label: "Audio only · 96 kbit/s",
    description: "Voice or audio broadcasts without video.",
    audioOnly: true,
    width: 1280,
    height: 720,
    fps: 30,
    videoBitrate: 2500000,
    audioBitrate: 96000,
  },
] as const;
export type StreamEncoding = Omit<ConsoleStream["profile"], "layout">;
export function encodingFromPreset(preset: (typeof streamQualityPresets)[number]): StreamEncoding {
  const { audioOnly, width, height, fps, videoBitrate, audioBitrate } = preset;
  return { audioOnly, width, height, fps, videoBitrate, audioBitrate };
}
export function matchingQualityPreset(profile: StreamEncoding) {
  return (
    streamQualityPresets.find(
      (p) =>
        p.audioOnly === profile.audioOnly &&
        (p.audioOnly
          ? p.audioBitrate === profile.audioBitrate
          : p.width === profile.width &&
            p.height === profile.height &&
            p.fps === profile.fps &&
            p.videoBitrate === profile.videoBitrate &&
            p.audioBitrate === profile.audioBitrate),
    )?.id ?? "custom"
  );
}
