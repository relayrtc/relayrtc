import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { roomInput } from "./encoder.js";
import { roomDecoderArguments } from "./room-decoder.js";

it("separates room RTP media so microphone stalls cannot block the camera", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relayrtc-decoder-test-"));
  try {
    const input = await roomInput(
      [
        { id: "mic", kind: "audio", trackType: "microphone", codec: "opus", sdp: "audio" },
        { id: "cam", kind: "video", trackType: "camera", codec: "vp8", sdp: "video" },
      ],
      directory,
    );
    const video = input.mediaInputs?.video;
    const audio = input.mediaInputs?.audio;
    expect(video?.video).toEqual(["0:v:0"]);
    expect(audio?.audio).toEqual(["0:a:0"]);
    if (!video || !audio) throw new Error("Expected independent audio and video inputs");
    const videoArgs = roomDecoderArguments(video, "video", 1920, 1080, 30).join(" ");
    expect(videoArgs).toContain("track-1.sdp");
    expect(videoArgs).not.toContain("track-0.sdp");
    expect(videoArgs).toContain("scale=1920:1080");
    expect(videoArgs).toContain("-reinit_filter 0");
    expect(videoArgs).toContain("-fps_mode passthrough");
    expect(videoArgs).not.toContain("amix");
    expect(videoArgs).not.toContain("anullsrc");
    const audioArgs = roomDecoderArguments(audio, "audio", 1920, 1080, 30).join(" ");
    expect(audioArgs).toContain("track-0.sdp");
    expect(audioArgs).not.toContain("track-1.sdp");
    expect(audioArgs).not.toContain("fps=");
  } finally {
    await rm(directory, { recursive: true });
  }
});
