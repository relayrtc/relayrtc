/** Live-edge targets in seconds, measured against the HLS playlist, not capture time. */
export interface LivePlaybackOptions {
  /** Default: 3 seconds. */
  liveSyncDuration?: number;
  /** Default: 8 seconds. Must exceed liveSyncDuration. */
  liveMaxLatencyDuration?: number;
  /** Default: 1.1. Use 1 to disable gradual playback acceleration. */
  maxLiveSyncPlaybackRate?: number;
  /** Default: 0.25 seconds added to the target after a stall. */
  liveSyncOnStallIncrease?: number;
}

/** Structurally compatible with hls.js config; hls.js remains an optional app dependency. */
export interface HlsPlaybackConfig {
  lowLatencyMode: boolean;
  /** hls.js 1.7+: avoid recovery seeks ahead of downloaded media. */
  liveSyncMode: "buffered";
  backBufferLength: number;
  maxBufferLength: number;
  maxMaxBufferLength: number;
  liveSyncDuration: number;
  liveMaxLatencyDuration: number;
  maxLiveSyncPlaybackRate: number;
  liveSyncOnStallIncrease: number;
}

/**
 * Pass this configuration to an application-owned hls.js engine.
 * Live mode catches up after stalls; DVR/VOD never force an intentional rewind forward.
 * Live options apply only to live mode. Native HLS is controlled by the browser.
 */
export function getHlsPlaybackConfig(
  mode: "live" | "dvr" | "vod" = "live",
  liveOptions: LivePlaybackOptions = {},
): HlsPlaybackConfig {
  const config: HlsPlaybackConfig = {
    lowLatencyMode: mode === "live",
    liveSyncMode: "buffered",
    backBufferLength: 1800,
    maxBufferLength: 20,
    maxMaxBufferLength: 60,
    liveSyncDuration: mode === "live" ? (liveOptions.liveSyncDuration ?? 3) : 6,
    liveMaxLatencyDuration: mode === "live" ? (liveOptions.liveMaxLatencyDuration ?? 8) : Infinity,
    maxLiveSyncPlaybackRate: mode === "live" ? (liveOptions.maxLiveSyncPlaybackRate ?? 1.1) : 1,
    liveSyncOnStallIncrease: mode === "live" ? (liveOptions.liveSyncOnStallIncrease ?? 0.25) : 0,
  };
  if (mode === "live") {
    if (!Number.isFinite(config.liveSyncDuration) || config.liveSyncDuration <= 0)
      throw new Error("liveSyncDuration must be a positive finite number");
    if (!Number.isFinite(config.liveMaxLatencyDuration) || config.liveMaxLatencyDuration <= config.liveSyncDuration)
      throw new Error("liveMaxLatencyDuration must be finite and exceed liveSyncDuration");
    if (!Number.isFinite(config.maxLiveSyncPlaybackRate) || config.maxLiveSyncPlaybackRate < 1 || config.maxLiveSyncPlaybackRate > 2)
      throw new Error("maxLiveSyncPlaybackRate must be between 1 and 2");
    if (!Number.isFinite(config.liveSyncOnStallIncrease) || config.liveSyncOnStallIncrease < 0)
      throw new Error("liveSyncOnStallIncrease must be a non-negative finite number");
  }
  return config;
}
