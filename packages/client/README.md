# @relayrtc/client

## Streaming polling and rate limits

Broadcast, recording, playback, clip, mixer and scheduled-broadcast clients apply bounded exponential polling backoff (up to 60 seconds for ordinary failures) and honor a longer `retryAfterMs` supplied by an application callback. Cooldown also applies to manual refresh/recovery calls and commands. A successful observation returns to the configured polling cadence once cooldown has elapsed. Disconnect resets the client's cooldown.

When forwarding an HTTP failure from your application backend, throw an error with a numeric HTTP `status` and `retryAfterMs` in milliseconds, parsed from `Retry-After`. The SDK exposes a sanitized `StreamingRequestError` in the snapshot: `status` and `retryAfterMs` are retained, but endpoint URLs, response bodies and original causes are not. Import `StreamingRequestError` to inspect those fields. Each client owns its cooldown; applications sharing an IP/project budget should additionally coordinate cooldown across their HTTP callbacks. REST polling is intentional; this change does not replace it with server push.

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

## Room access

`room.access.current` exposes effective capabilities; `room.access.get` and `room.access.update` manage versioned participant policies through signaling. Observe `capabilitiesChanged` and unsubscribe on disposal. See [room policy](https://docs.relayrtc.com/guides/room-roles-and-permissions) for compatibility and enforcement timing.
## Room admission and lifecycle

Version 0.1.4 adds `room.lifecycle.current`, `room.lifecycle.get()`, `room.lifecycle.update({ version, locked, endsAt })` and `lifecycleChanged`. Hosts and moderators manage policy through their joined session. Invitation operations use your authenticated application backend through the exported `RoomInvitationBackend` contract. See [room admission](https://docs.relayrtc.com/guides/room-admission-and-lifecycle) for lock, reconnect, invitation and deadline behavior. These additions require compatible services and migration `0046_room_lifecycle`.
## Speakers, activity and push-to-talk

Version 0.1.4 adds `room.activity.current/get/configure`, `activityChanged`, initial `RelayClientOptions.activity` privacy preferences and `createPushToTalk(room)`. Presence activity is separate from connection state and microphone observation. Dispose the single push-to-talk controller owning a microphone when its view closes. These features require migration `0047_room_activity` and coordinated services/SDK builds. See [speaker and activity behavior](https://docs.relayrtc.com/guides/speakers-activity-and-push-to-talk).
