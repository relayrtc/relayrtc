import { execFileSync } from "node:child_process";
import { appendFileSync, openSync, closeSync } from "node:fs";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const { values } = parseArgs({
  options: {
    room: { type: "string" },
    samples: { type: "string", default: "5" },
    interval: { type: "string", default: "15" },
    output: { type: "string" },
    diagnostics: { type: "boolean", default: false },
  },
});
if (!values.room || !/^[A-Za-z0-9_-]{1,128}$/u.test(values.room))
  throw new Error("Provide --room with a valid room ID");
const samples = Number(values.samples);
const interval = Number(values.interval);
if (
  !Number.isInteger(samples) ||
  samples < 2 ||
  samples > 120 ||
  !Number.isInteger(interval) ||
  interval < 5 ||
  interval > 60 ||
  samples * interval > 1_800
)
  throw new Error("Use 2-120 samples, intervals of 5-60 seconds and at most 30 minutes total");
if (values.output) closeSync(openSync(values.output, "wx", 0o600));

const query = `
BEGIN READ ONLY;
SELECT jsonb_build_object(
  'at',clock_timestamp(),
  'room',jsonb_build_object('id',r.id,'startedAt',r.started_at,'status',r.status),
  'activeRooms',(SELECT count(*) FROM room ar WHERE ar.status='active' AND EXISTS(
    SELECT 1 FROM participant p JOIN participant_session s ON s.participant_id=p.id
    WHERE p.room_id=ar.id AND p.left_at IS NULL AND s.connection_state='connected')),
  'sessions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'state',s.connection_state))
    FROM participant_session s JOIN participant p ON p.id=s.participant_id
    WHERE p.room_id=r.id AND s.connection_state IN ('connected','reconnecting')),'[]'),
  'totals',(SELECT coalesce(jsonb_object_agg(t.metric,t.bytes),'{}') FROM (
    SELECT metric,sum(value) AS bytes FROM usage_event WHERE room_id=r.id
    AND metric IN ('sfuIngressBytes','sfuEgressBytes','screenShareIngressBytes','screenShareEgressBytes',
      'turnIngressBytes','turnEgressBytes') GROUP BY metric) t),
  'latestEventAt',(SELECT max(occurred_at) FROM usage_event WHERE room_id=r.id
    AND metric IN ('sfuIngressBytes','sfuEgressBytes')),
  'resources',coalesce((SELECT jsonb_agg(jsonb_build_object('sessionId',s.key,
    'tracks',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',t.key,'type',t.value->>'Type',
      'mediaId',t.value->>'MediaID','state',t.value->>'State')),'[]')
      FROM jsonb_each(coalesce(s.value->'Tracks','{}')) t),
    'subscriptions',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.key,
      'trackId',c.value->>'TrackID','mediaId',c.value->>'MediaID','transportId',c.value->>'TransportID')),'[]')
      FROM jsonb_each(coalesce(s.value->'Subscriptions','{}')) c)))
    FROM rtc_runtime m CROSS JOIN LATERAL jsonb_each(coalesce(m.state->'Sessions','{}')) s
    WHERE m.room_id=r.id),'[]'))
FROM room r WHERE r.id='${values.room}';
ROLLBACK;
`;

const networkProgram = `
import fs from 'node:fs';
const read = name => Number(fs.readFileSync('/sys/class/net/eth0/statistics/'+name,'utf8'));
console.log(JSON.stringify({at:new Date().toISOString(),networkNamespace:fs.statSync('/proc/self/ns/net').ino,uptime:fs.readFileSync('/proc/uptime','utf8').split(' ')[0],rx:read('rx_bytes'),tx:read('tx_bytes')}));
`;
const diagnosticsProgram = `
import {createMediaControlToken} from '@relayrtc/protocol/media-control';
const roomId=process.argv[2];
const path='/internal/v1/rooms/'+roomId+'/usage-diagnostics';
const token=createMediaControlToken(process.env.RELAYRTC_INTERNAL_SECRET,{service:'relayrtc-api',method:'GET',path,authority:{kind:'room',roomId}});
const response=await fetch('http://127.0.0.1:'+(process.env.MEDIA_PORT||8082)+path,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
if(!response.ok){console.log(JSON.stringify({status:'unavailable',httpStatus:response.status}));}
else console.log(JSON.stringify({status:'available',snapshot:await response.json()}));
`;

function docker(args, input) {
  return execFileSync("docker", args, {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 2_097_152,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const startedAt = Date.now();
let previous;
let observationFailed = false;
for (let index = 0; index < samples; index++) {
  if (index > 0) await delay(Math.max(0, startedAt + index * interval * 1_000 - Date.now()));
  const networkBefore = JSON.parse(
    docker(
      ["exec", "-i", "-w", "/workspace", "relayrtc-media-1", "node", "--input-type=module"],
      networkProgram,
    ),
  );
  const rawDatabase = docker(
    [
      "exec",
      "-i",
      "relayrtc-postgres-1",
      "sh",
      "-c",
      'exec psql -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1',
    ],
    query,
  );
  if (!rawDatabase) throw new Error("The requested room was not found");
  const database = JSON.parse(rawDatabase);
  const networkAfter = JSON.parse(
    docker(
      ["exec", "-i", "-w", "/workspace", "relayrtc-media-1", "node", "--input-type=module"],
      networkProgram,
    ),
  );
  const observation = { index, database, networkBefore, networkAfter };
  if (values.diagnostics)
    observation.diagnostics = JSON.parse(
      docker(
        [
          "exec",
          "-i",
          "-w",
          "/workspace/services/media",
          "relayrtc-media-1",
          "node",
          "--input-type=module",
          "-",
          values.room,
        ],
        diagnosticsProgram,
      ),
    );
  if (previous) {
    const elapsedSeconds = (Date.parse(database.at) - Date.parse(previous.database.at)) / 1_000;
    const ingress =
      (database.totals.sfuIngressBytes ?? 0) - (previous.database.totals.sfuIngressBytes ?? 0);
    const egress =
      (database.totals.sfuEgressBytes ?? 0) - (previous.database.totals.sfuEgressBytes ?? 0);
    const rx = networkAfter.rx - previous.networkAfter.rx;
    const tx = networkAfter.tx - previous.networkAfter.tx;
    const reset =
      networkAfter.networkNamespace !== previous.networkAfter.networkNamespace ||
      Number(networkAfter.uptime) < Number(previous.networkAfter.uptime) ||
      ingress < 0 ||
      egress < 0 ||
      rx < 0 ||
      tx < 0;
    observation.interval = {
      elapsedSeconds,
      ingress,
      egress,
      interfaceRx: rx,
      interfaceTx: tx,
      counterReset: reset,
      ingressMbps: reset ? null : (ingress * 8) / elapsedSeconds / 1_000_000,
      egressMbps: reset ? null : (egress * 8) / elapsedSeconds / 1_000_000,
    };
    if (reset) observationFailed = true;
  }
  const line = JSON.stringify(observation);
  if (values.output) appendFileSync(values.output, line + "\n");
  process.stdout.write(line + "\n");
  previous = observation;
}
if (observationFailed) process.exitCode = 1;
