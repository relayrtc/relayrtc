import { schema } from "@relayrtc/database";
import type { AuditActor } from "@relayrtc/auth/server";
import { createBroadcastSchema, recordingPolicySchema } from "@relayrtc/validation";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import type { StreamingConfig } from "./config.js";
import { getStream, id, missing, conflict, type Transaction, type Scope } from "./repository.js";
import { destinationContext, destinationVault, publicDestination } from "./destinations.js";
import { admitRecording } from "./recording-service.js";
import {
  broadcastEvent,
  broadcastAudit,
  broadcastOperation,
  changeBroadcast,
  type RunRow,
} from "./broadcast-service.js";

export async function createBroadcastRun(
  db: Transaction,
  input: z.infer<typeof createBroadcastSchema>,
  scope: Scope,
  organizationId: string,
  actor: AuditActor,
  correlationId: string,
  config: StreamingConfig,
) {
  const stream = await getStream(db, input.streamId, true);
  if (
    stream.projectId !== scope.projectId ||
    stream.environmentId !== scope.environmentId ||
    stream.status !== "active"
  )
    throw missing();
  const destinations = [];
  for (const destinationId of input.destinationIds) {
    const [destination] = await db
      .select()
      .from(schema.streamDestination)
      .where(
        and(
          eq(schema.streamDestination.id, destinationId),
          eq(schema.streamDestination.streamId, stream.id),
        ),
      )
      .for("share");
    if (
      !destination ||
      destination.deletedAt ||
      !destination.enabled ||
      !destination.encryptedSecret
    )
      throw conflict(
        "DESTINATION_UNAVAILABLE",
        "Select enabled destinations belonging to this stream.",
      );
    destinationVault(config).decrypt(
      destination.encryptedSecret,
      destinationContext(destination.id, destination.credentialVersion),
    );
    destinations.push(destination);
  }
  if (destinations.length > config.maxDestinations)
    throw conflict("DESTINATION_LIMIT", "Too many destinations for this run.");
  const profile = stream.profile as { videoBitrate: number; audioBitrate: number };
  const bitrate = destinations.reduce(
    (total, d) =>
      total +
      (d.profile === "720p"
        ? 2500000 + 128000
        : d.profile === "1080p"
          ? 5000000 + 128000
          : profile.videoBitrate + profile.audioBitrate),
    0,
  );
  if (bitrate > config.maxEgressBitrate)
    throw conflict(
      "EGRESS_BITRATE_LIMIT",
      "The selected outputs exceed the stream egress bitrate limit.",
    );
  const [recordingPolicy] = await db.execute(
    sql`SELECT policy FROM stream_recording_policy WHERE stream_id=${stream.id}`,
  );
  const [run] = await db
    .insert(schema.broadcastRun)
    .values({
      id: id("broadcast"),
      streamId: stream.id,
      ...scope,
      organizationId: organizationId,
      name: input.name,
      waitTimeoutSeconds: input.waitTimeoutSeconds,
      maxDurationSeconds: Math.min(input.maxDurationSeconds, stream.maxDurationSeconds),
      correlationId: correlationId,
      snapshot: {
        streamVersion: stream.version,
        source: stream.source,
        profile: stream.profile,
        outputs: input.outputs,
        destinations: destinations.map((d) => ({
          id: d.id,
          version: d.version,
          credentialVersion: d.credentialVersion,
          name: d.name,
          profile: d.profile,
        })),
        recording:
          recordingPolicy &&
          recordingPolicySchema.parse(recordingPolicy.policy).mode === "automatic"
            ? recordingPolicySchema.parse(recordingPolicy.policy)
            : false,
      },
    })
    .returning();
  if (!run) throw missing();
  for (const output of input.outputs)
    await db.insert(schema.broadcastOutput).values({
      id: id("output"),
      broadcastId: run.id,
      kind: output.kind,
      configuration: output,
    });
  for (const destination of destinations)
    await db.insert(schema.broadcastOutput).values({
      id: id("output"),
      broadcastId: run.id,
      kind: "rtmp",
      destinationId: destination.id,
      credentialVersion: destination.credentialVersion,
      encryptedSecret: destination.encryptedSecret,
      configuration: {
        destinationId: destination.id,
        name: publicDestination(destination).name,
        profile: destination.profile,
      },
    });
  await broadcastEvent(db, run, "broadcast.created", actor);
  await broadcastAudit(db, run, actor, "broadcast.created", correlationId);
  return run;
}
export async function startBroadcastRun(
  db: Transaction,
  run: RunRow,
  actor: AuditActor,
  correlationId: string,
  config: StreamingConfig,
) {
  await getStream(db, run.streamId, true);
  const [guestStage]=await db.execute(sql`SELECT broadcast_id FROM stream_guest_stage WHERE stream_id=${run.streamId} AND broadcast_id<>${run.id} AND enabled`);
  if(guestStage)throw conflict("GUEST_PROGRAM_RESERVED","Another broadcast owns this stream's guest stage.");
  const [mixer] = await db.execute(
    sql`SELECT id FROM mixer WHERE stream_id=${run.streamId} AND broadcast_id<>${run.id} AND state NOT IN ('stopped','failed')`,
  );
  if (mixer)
    throw conflict("MIXER_EXCLUSIVE_SOURCE", "Another broadcast owns this stream's mixer.");
  if (run.state !== "created" || run.desiredState !== "idle")
    throw conflict(
      "BROADCAST_ALREADY_STARTED",
      "Create a new run instead of restarting this broadcast",
    );
  const stream = await getStream(db, run.streamId);
  if (stream.status !== "active" || stream.version !== run.snapshot.streamVersion)
    throw conflict(
      "BROADCAST_SOURCE_CHANGED",
      "Create a new run using the current stream configuration",
    );
  const outputs = await db
    .select()
    .from(schema.broadcastOutput)
    .where(eq(schema.broadcastOutput.broadcastId, run.id));
  const destinations = outputs.filter((output) => output.kind === "rtmp");
  if (destinations.length > config.maxDestinations)
    throw conflict("DESTINATION_LIMIT", "The saved outputs exceed the current destination limit.");
  const profile = stream.profile as { videoBitrate: number; audioBitrate: number };
  let bitrate = 0;
  for (const output of destinations) {
    if (!output.destinationId || !output.credentialVersion || !output.encryptedSecret)
      throw conflict("DESTINATION_UNAVAILABLE", "A saved destination credential is unavailable.");
    destinationVault(config).decrypt(
      output.encryptedSecret,
      destinationContext(output.destinationId, output.credentialVersion),
    );
    bitrate +=
      output.configuration.profile === "720p"
        ? 2628000
        : output.configuration.profile === "1080p"
          ? 5128000
          : profile.videoBitrate + profile.audioBitrate;
  }
  if (bitrate > config.maxEgressBitrate)
    throw conflict(
      "EGRESS_BITRATE_LIMIT",
      "Saved outputs exceed the current egress bitrate limit.",
    );
  await db.execute(sql`SELECT pg_advisory_xact_lock(810034)`);
  const [capacity] = await db.execute(
    sql`SELECT count(*)::int AS total,count(*) FILTER (WHERE environment_id=${run.environmentId})::int AS environment FROM broadcast_run WHERE desired_state='running' OR state='stopping'`,
  );
  if (
    Number(capacity?.total) >= config.maxBroadcasts ||
    Number(capacity?.environment) >= config.maxBroadcastsPerEnvironment
  )
    throw conflict("BROADCAST_CAPACITY", "Broadcast run capacity is full");
  await db
    .update(schema.broadcastRun)
    .set({
      desiredState: "running",
      startRequestedAt: new Date(),
      sourceLostAt: new Date(),
      correlationId: correlationId,
    })
    .where(eq(schema.broadcastRun.id, run.id));
  const updated = await changeBroadcast(db, run, "waiting_for_source");
  await broadcastEvent(db, updated, "broadcast.starting", actor);
  for (const output of outputs)
    await db.insert(schema.broadcastJob).values({
      id: id("bjob"),
      broadcastId: run.id,
      outputId: output.id,
      kind: output.kind,
    });
  if (run.snapshot.recording) {
    await admitRecording(
      db,
      stream,
      run.id,
      recordingPolicySchema.parse(run.snapshot.recording),
      config,
    );
  }
  await broadcastAudit(db, run, actor, "broadcast.start.requested", correlationId);
  return broadcastOperation(db, updated, "broadcast.start");
}
