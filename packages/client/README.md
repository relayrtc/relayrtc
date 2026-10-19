# @relayrtc/client

## Join and leave a room

```ts
import { RelayClient, RoomError } from "@relayrtc/client";

const relay = new RelayClient({
  signalingUrl: "wss://rtc.example.com/v1/connect",
  requestTimeoutMs: 10_000,
});

relay.on("connectionStateChanged", (state) => renderConnectionState(state));
relay.on("error", (error) => showError(error.code));

const controller = new AbortController();
try {
  const token = await getParticipantTokenFromYourServer();
  const room = await relay.join(token, { signal: controller.signal });
  console.log(room.id, room.localParticipant, room.session);
  await room.leave();
} catch (error) {
  if (error instanceof RoomError) showError(error.code);
  else throw error;
}
```

## Room microphone, camera and screen sharing

```ts
const room = await relay.join(token);

await room.microphone.enable();
await room.camera.enable({ width: 1280, height: 720 });

await room.microphone.mute();
await room.microphone.unmute();

const devices = await room.devices.enumerate();
if (devices.microphones[0]) {
  await room.microphone.switchDevice(devices.microphones[0].deviceId);
}
if (devices.cameras[0]) {
  await room.camera.switchDevice(devices.cameras[0].deviceId);
}

const unsubscribe = room.camera.subscribe((snapshot) => {
  console.log(snapshot.enabled, snapshot.muted, snapshot.publication);
});

await room.screen.start({ video: true, audio: true });
await room.screen.stop();
await room.camera.disable();
await room.microphone.disable();
unsubscribe();
await room.leave();
```

## Standalone media helpers

```ts
import { MediaManager } from "@relayrtc/client";

const media = new MediaManager();

await media.permissions.request({ microphone: true, camera: true });

const devices = await media.devices.enumerate();
const microphoneTrack = await media.microphone.enable();
const cameraTrack = await media.camera.enable({ width: 1280, height: 720 });

await media.microphone.switchDevice(devices.microphones[0].deviceId);
await media.camera.switchDevice(devices.cameras[0].deviceId);

media.microphone.disable();
media.camera.disable();
```

## Audio and video connectivity

```ts
import { MediaConnection } from "@relayrtc/client";

const connection = new MediaConnection({
  configuration: {
    iceServers: [{ urls: "stun:stun.example.com:3478" }],
  },
});

await connection.enableMicrophone();
await connection.enableCamera({ width: 1280, height: 720 });

connection.rtc.onRemoteTrack(({ track, streams }) => {
  const stream = streams[0] ?? new MediaStream([track]);
  remoteVideo.srcObject = stream;
});

const offer = await connection.rtc.createOffer();
sendOfferThroughSignaling(offer);
```

## ICE lifecycle

```ts
connection.rtc.onIceCandidate((candidate) => {
  sendCandidateThroughSignaling(candidate);
});

await connection.rtc.addIceCandidate(remoteCandidate);

connection.rtc.subscribe(({ state, iceConnectionState }) => {
  renderConnectionState(state, iceConnectionState);
});

const restartOffer = await connection.rtc.restartIce();
sendOfferThroughSignaling(restartOffer);
```
