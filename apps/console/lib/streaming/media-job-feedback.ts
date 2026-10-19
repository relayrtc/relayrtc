import type { ClipResource, DvrPlayback } from "@relayrtc/types";

const messages: Record<string, string> = {
  CLIP_PREPARATION_TIMEOUT:
    "Clip preparation exceeded its 10-minute deadline. Create a new clip while the source media is still retained.",
  CLIP_RENDERING_TIMEOUT:
    "Clip rendering exceeded its 15-minute deadline. Create a new clip with a shorter interval.",
  CLIP_PREPARATION_RETRIES_EXHAUSTED:
    "Clip preparation could not finish after repeated interruptions. Check media storage availability, then create a new clip.",
  CLIP_RENDERING_RETRIES_EXHAUSTED:
    "Rendering could not finish after repeated interruptions. Create a new clip after the media service recovers.",
  CLIP_SOURCE_LOST:
    "The source media is no longer available. Choose another recording or a retained interval from a live broadcast.",
  CLIP_SEGMENT_MISSING:
    "Some source media is no longer available. Choose an interval that is still retained.",
  CLIP_SEGMENT_CONFLICT:
    "The copied media did not match the source. Create a new clip from another retained interval.",
  CLIP_STORAGE_LIMIT: "This clip exceeds the media storage limit. Create a shorter clip.",
  CLIP_PREPARATION_RETRY: "Media could not be copied. Preparation will retry automatically.",
  CLIP_PREPARATION_INTERRUPTED: "Preparation was interrupted and has resumed automatically.",
  CLIP_PREPARATION_LEASE_EXPIRED: "Preparation was interrupted. It will retry automatically.",
  DVR_MAINTENANCE_RETRY:
    "Rewind maintenance is delayed and will retry automatically. Other broadcasts can continue.",
  RECORDING_WORKER_FAILED:
    "The media service was interrupted. Processing will retry automatically.",
  RECORDING_RETRIES_EXHAUSTED:
    "Media processing could not finish after repeated interruptions. Create a new clip after the media service recovers.",
  WORKER_INTERRUPTED: "The media service was interrupted. Processing will retry automatically.",
  BUFFER_STORAGE_PRESSURE:
    "Rewind capture has reached its storage limit. Retained media is being reduced to make room for new media.",
  RECORDING_NO_MEDIA:
    "Capture ended before any media arrived. Check the publisher connection and start a new broadcast.",
  RECORDING_STORAGE_LIMIT:
    "Capture reached its storage limit. Reduce the retained interval or start a new broadcast with suitable storage limits.",
};

export function mediaJobError(code: string | null) {
  return code
    ? (messages[code] ??
        "Media processing encountered a problem. Check media service availability and choose retained source media or start a new broadcast.")
    : "";
}

export function clipStage(clip: ClipResource) {
  return clip.progress?.stage ?? clip.state;
}

export function clipFeedback(clip: ClipResource) {
  const progress = clip.progress;
  if (clip.state === "failed")
    return (
      mediaJobError(clip.lastError) ||
      "This clip could not finish. Create a new clip from retained source media. You can delete the failed clip."
    );
  const details: string[] = [];
  if (progress?.nextAttemptAt)
    details.push(`Retry scheduled for ${new Date(progress.nextAttemptAt).toLocaleTimeString()}.`);
  else if (clipStage(clip) === "preparing" || (clip.state === "queued" && progress?.copiedObjects))
    details.push(
      `Preparing media: ${progress?.copiedObjects ?? 0} of ${progress?.totalObjects ?? 0} objects copied.`,
    );
  else if (clip.state === "queued") details.push("Waiting for media preparation.");
  else if (clip.state === "rendering") details.push("Rendering the clip for playback.");
  if (clip.lastError) details.push(mediaJobError(clip.lastError));
  if (progress?.attempts)
    details.push(`${progress.attempts} of ${progress.maxAttempts} processing attempts used.`);
  if (progress?.deadlineAt)
    details.push(`Processing deadline: ${new Date(progress.deadlineAt).toLocaleTimeString()}.`);
  return details.join(" ");
}

export function dvrFeedback(playback: DvrPlayback | null) {
  if (!playback) return "Checking rewind media. This page updates automatically.";
  if (playback.capture?.state === "failed")
    return "Rewind capture failed. Start a new broadcast after the media service recovers; retained media remains subject to its expiry.";
  if (playback.capture?.state === "deleting" || playback.capture?.state === "deleted")
    return "This broadcast's retained media is being removed or has expired. Start a new broadcast with rewind enabled.";
  if (
    playback.capture?.lastError &&
    (playback.capture.retrying || playback.capture.state !== "ready")
  )
    return mediaJobError(playback.capture.lastError);
  if (playback.capture?.state === "queued")
    return "Rewind capture is queued. Media will appear after capture starts.";
  if (playback.capture?.state === "recording" && playback.state === "starting")
    return "Capture has started. Waiting for the first playable media.";
  if (playback.capture?.state === "finalizing")
    return "Capture has ended and is finishing. Retained media will remain available until expiry.";
  if (playback.capture?.state === "not_configured")
    return "Enable rewind before starting a broadcast. Changes apply to the next broadcast.";
  if (playback.state === "unavailable" && playback.capture?.state === "ready")
    return "This broadcast has no retained rewind media available. Start a new broadcast with rewind enabled.";
  if (playback.state === "live") return "Rewind is available and updates as new media arrives.";
  if (playback.state === "ended")
    return "The broadcast has ended. Rewind remains available until its retention period ends.";
  return "Rewind media appears as a broadcast arrives. If no capture is available, check buffer capacity or start a new broadcast with rewind enabled.";
}
