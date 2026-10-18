export const mixerEventTypes = [
  "mixer.started",
  "mixer.scene_activated",
  "mixer.source_lost",
  "mixer.overloaded",
  "mixer.stopped",
  "mixer.failed",
] as const;
export interface MixerSource {
  id: string;
  streamId: string;
}
export interface MixerLayer {
  sourceId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  fit: "contain" | "cover";
  opacity: number;
}
export interface MixerOverlayLayer {
  overlayId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  opacity: number;
}
export interface MixerTextLayer {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  fontSize: number;
  color: string;
  opacity: number;
}
export interface MixerAudio {
  sourceId: string;
  gainDb: number;
  muted: boolean;
}
export interface MixerScene {
  name: string;
  layout: "single" | "grid" | "pip" | "custom";
  background: string;
  layers: MixerLayer[];
  overlays: MixerOverlayLayer[];
  texts: MixerTextLayer[];
  audio: MixerAudio[];
  ducking: { sourceId: string; threshold: number; attenuationDb: number } | null;
  transition: "cut";
}
export interface MixerSceneResource {
  id: string;
  mixerId: string;
  version: number;
  scene: MixerScene;
}
export interface MixerOverlay {
  id: string;
  name: string;
  width: number;
  height: number;
  sizeBytes: number;
}
export interface MixerResource {
  id: string;
  broadcastId: string;
  streamId: string;
  projectId: string;
  environmentId: string;
  state: "created" | "preparing" | "live" | "degraded" | "stopping" | "stopped" | "failed";
  version: number;
  desiredVersion: number;
  appliedVersion: number;
  desiredSceneId: string | null;
  appliedSceneId: string | null;
  sources: MixerSource[];
  overlays: MixerOverlay[];
  lostSources: string[];
  lastError: string | null;
  usage: { renderSeconds: number; programSeconds: number; inputSeconds: number; frames: number };
  limits: {
    canvasWidth: number;
    canvasHeight: number;
    fps: number;
    maxInputs: number;
    maxLayers: number;
    gpu: boolean;
  };
  createdAt: string;
  endedAt: string | null;
}
export interface MixerOperation {
  id: string;
  mixerId: string;
  kind: "activate" | "stop";
  revision: number;
  status: "pending" | "completed" | "failed";
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface MixerCommandResult {
  mixer: MixerResource;
  operation: MixerOperation;
}
export interface CreateMixerInput {
  sources?: MixerSource[];
}
export interface PutMixerSceneInput {
  version: number;
  scene: MixerScene;
}
export interface ActivateMixerSceneInput {
  version: number;
  sceneId: string;
  sceneVersion: number;
}
export interface CreateMixerOverlayInput {
  name: string;
  contentType: "image/png";
  dataBase64: string;
}
