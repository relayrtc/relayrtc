import { randomUUID } from "node:crypto";
import type { RelayKitDatabase } from "@relayrtc/database";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServiceUsageMetric } from "@relayrtc/types";
import { sql } from "drizzle-orm";
import { observeServiceUsage, usageIdentity, type ServiceUsageOwner } from "./service-usage.js";

export async function meterMediaResponse(
  database: RelayKitDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
  owner: ServiceUsageOwner,
  grantSubject: string,
  viewerActivity: boolean,
  completed?: (
    db: Parameters<Parameters<RelayKitDatabase["transaction"]>[0]>[0],
    bytes: number,
    identity: string,
  ) => Promise<void>,
) {
  if (request.method === "HEAD") return;
  const response = reply.raw,
    originalWrite = response.write.bind(response),
    originalEnd = response.end.bind(response);
  const identity = `delivery:${randomUUID()}`;
  const deliveryMetric =
    owner.resourceType === "recording"
      ? "recordingDeliveryBytes"
      : owner.resourceType === "clip"
        ? "clipDeliveryBytes"
        : owner.resourceType === "dvr"
          ? "dvrDeliveryBytes"
          : "liveDeliveryBytes";
  const intentAt = new Date();
  await database.transaction((db) =>
    observeServiceUsage(
      db,
      owner,
      identity,
      { [deliveryMetric]: 0 },
      intentAt,
      intentAt,
      "partial",
    ),
  );
  let bytes = 0,
    settled = false;
  const count = (chunk: unknown, encoding: unknown) => {
    if (typeof chunk === "string")
      bytes += Buffer.byteLength(
        chunk,
        typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
      );
    else if (ArrayBuffer.isView(chunk)) bytes += chunk.byteLength;
  };
  response.write = function (chunk: unknown, ...args: unknown[]) {
    count(chunk, args[0]);
    return Reflect.apply(originalWrite, response, [chunk, ...args]) as boolean;
  } as typeof response.write;
  response.end = function (chunk?: unknown, ...args: unknown[]) {
    count(chunk, args[0]);
    return Reflect.apply(originalEnd, response, [chunk, ...args]) as typeof response;
  } as typeof response.end;
  const settle = (complete: boolean) => {
    if (settled) return;
    settled = true;
    response.write = originalWrite;
    response.end = originalEnd;
    if (reply.statusCode >= 400 || !bytes) return;
    const endedAt = new Date();
    void database
      .transaction(async (db) => {
        const metrics: Partial<Record<ServiceUsageMetric, number>> = {};
        metrics[complete ? deliveryMetric : "abortedDeliveryBytes"] = bytes;
        const actorKey =
          viewerActivity && complete
            ? usageIdentity(
                `${owner.resourceType}:${owner.resourceId}:${owner.runId}:${grantSubject}`,
              )
            : null;
        let startedAt = endedAt;
        if (actorKey) {
          await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${actorKey},810045))`);
          const [last] = await db.execute(
            sql`SELECT ended_at FROM service_usage_sample WHERE actor_key=${actorKey} ORDER BY ended_at DESC LIMIT 1`,
          );
          const previous = last ? new Date(String(last.ended_at)) : null;
          const elapsed = previous ? endedAt.getTime() - previous.getTime() : 0;
          if (previous && elapsed > 0 && elapsed <= 30000) startedAt = previous;
          metrics.viewerSeconds = Math.max(0, (endedAt.getTime() - startedAt.getTime()) / 1000);
        }
        const updated = await db.execute(
          sql`UPDATE service_usage_sample SET metrics=${JSON.stringify(metrics)}::jsonb,started_at=${startedAt.toISOString()},ended_at=${endedAt.toISOString()},occurred_at=${endedAt.toISOString()},coverage=${complete ? "observed" : "partial"},actor_key=${actorKey} WHERE id=${usageIdentity(identity)} AND coverage='partial' AND revision=0 RETURNING id`,
        );
        if (updated.length && complete && completed)
          await completed(db, bytes, usageIdentity(identity));
      })
      .catch((err: unknown) => {
        request.log.error(
          { err, resourceId: owner.resourceId },
          "Media delivery observation failed",
        );
      });
  };
  response.once("finish", () => {
    settle(response.writableFinished);
  });
  response.once("close", () => {
    settle(response.writableFinished);
  });
}
