import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createRoomRuntimeStore } from "./engine/room-runtime-store.js";
import { buildApp } from "./app.js";
import { createDatabase } from "@relayrtc/database";
import { readMediaEnvironment } from "./config/environment.js";
import { createMediasoupWorker } from "./engine/mediasoup-factory.js";
import { MediasoupWorkerPool } from "./engine/worker-pool.js";
import { createHttpQualityEventPublisher } from "./quality/quality-event-publisher.js";
import { createQualityMetricsStore } from "./quality/quality-metrics-store.js";
import { QualityEventOutbox } from "./quality/quality-event-outbox.js";
import { createMediaUsageMetricsStore } from "./usage/usage-metrics-store.js";

const start = async (): Promise<void> => {
  const config = readMediaEnvironment(process.env);
  const database = createDatabase(config.databaseUrl, { maxConnections: 4 });
  const roomRuntimeStore = createRoomRuntimeStore(database.db, config.nodeId);
  try {
    await roomRuntimeStore.recover();
  } catch (error) {
    await database.close();
    throw error;
  }
  const lifecycle: { app?: FastifyInstance } = {};
  const publisher = createHttpQualityEventPublisher({
    internalSecret: config.internalSecret,
    signalingUrl: config.signalingInternalUrl,
  });
  const qualityError = (): void => {
    console.error(
      "Quality persistence or event delivery failed; queued observations will retry or expire",
    );
  };
  const qualityOutbox = new QualityEventOutbox(database.db, publisher, qualityError);
  const engine = new MediasoupWorkerPool(config, createMediasoupWorker, {
    speakerStore:createSpeakerStore(database.db,config.nodeId),
    onSpeakerError: (error) => {
      const cause = error instanceof Error ? error.cause ?? error : error;
      console.error(
        "Speaker observation persistence failed; observations will retry",
        cause instanceof Error ? cause.name : "UnknownError",
        typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
          ? cause.code
          : "UNKNOWN",
      );
    },
    roomRuntimeStore,
    onWorkerError: () => {
      console.error("Media worker recovery or room failure persistence will retry");
    },
    onWorkerExhausted: () => {
      process.exitCode = 1;
      console.error("Media worker replacement budget exhausted; stopping media service");
      if (lifecycle.app) void lifecycle.app.close();
    },
    eventPublisher: publisher,
    onQualityError: qualityError,
    metricsStore: createQualityMetricsStore(database.db),
    usageMetricsStore: createMediaUsageMetricsStore(database.db),
    onUsageError: (error) => {
      console.error(
        "Media usage persistence failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    },
  });
  try {
    await engine.start();
  } catch (error) {
    await database.close();
    throw error;
  }
  let guestSweep: Promise<void> | undefined;
  const knownGuests = new Map<string, { roomId: string; participantId: string }>();
  const sweepGuests = async () => {
    try {
      const previouslyKnown = [...knownGuests.values()];
      const rows = await database.db.execute(
        sql`SELECT ps.id,r.id AS room_id,guest_session_authorized(ps.id) AS allowed FROM participant_session ps JOIN participant p ON p.id=ps.participant_id JOIN room r ON r.id=p.room_id WHERE left(p.id,7)='guestp_' AND ps.media_node_id=${config.nodeId} AND (ps.connection_state IN ('connected','reconnecting') OR EXISTS(SELECT 1 FROM participant_removal_target t WHERE t.session_id=ps.id AND t.status<>'completed')) ORDER BY ps.joined_at DESC LIMIT 500`,
      );
      const present = new Set(rows.map((r) => String(r.id)));
      for (const old of previouslyKnown)
        if (!present.has(old.participantId)) {
          await engine.removeParticipant(old);
          knownGuests.delete(old.participantId);
        }
      for (const r of rows)
        knownGuests.set(String(r.id), { roomId: String(r.room_id), participantId: String(r.id) });
      for (const row of rows)
        if (row.allowed !== true)
          await engine.removeParticipant({
            roomId: String(row.room_id),
            participantId: String(row.id),
          });
    } catch {
      // Fail closed for known guest producers on authority-store failure; ordinary RTC is unaffected.
      for (const guest of knownGuests.values())
        await engine.removeParticipant(guest).catch(() => undefined);
    }
  };
  const guestTimer = setInterval(() => {
    guestSweep ??= sweepGuests().finally(() => {
      guestSweep = undefined;
    });
  }, 2000);
  guestTimer.unref();
  const usageTimer = setInterval(() => void engine.flushUsage(), 2_000);
  usageTimer.unref();
  let checkingQuality = false;
  const qualityTimer = setInterval(() => {
    if (checkingQuality) return;
    checkingQuality = true;
    void engine
      .checkQuality()
      .catch(qualityError)
      .finally(() => {
        checkingQuality = false;
      });
  }, 2000);
  qualityTimer.unref();
  qualityOutbox.start();
  const app = buildApp({
    database: database.db,
    rememberGuest: (roomId, participantId) => {
      knownGuests.set(participantId, { roomId, participantId });
    },
    config,
    engine,
    qualityDelivery: () => ({
      ...engine.qualityDelivery,
      pendingEvents: qualityOutbox.pending,
      expiredEvents: qualityOutbox.expired,
      deliveredEvents: qualityOutbox.delivered,
      failedAttempts: qualityOutbox.failed,
    }),
  });
  lifecycle.app = app;
  app.addHook("onClose", async () => {
    clearInterval(guestTimer);
    await guestSweep;
    clearInterval(usageTimer);
    clearInterval(qualityTimer);
    await engine.close();
    await qualityOutbox.close();
    await database.close();
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, "Stopping RelayRTC media service");
    await app.close();
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.fatal({ err: error }, "Unable to start RelayRTC media service");
    await app.close();
    process.exitCode = 1;
  }
};

void start();
import {createSpeakerStore} from "./activity/speaker-store.js";
