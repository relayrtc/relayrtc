import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  serviceUsageQuerySchema,
  serviceUsageReportSchema,
  streamingIdSchema,
} from "@relayrtc/validation";
import { validate } from "../../http/validation/validate.js";
import { getServiceUsage } from "../reporting/service-usage-report.js";
import { authorize, getStream, missing } from "./repository.js";
import { registerStreamingManagementAuth } from "./management-auth.js";
import type { StreamingRoutesOptions } from "./routes.js";

export const streamingUsageRoutes: FastifyPluginAsync<StreamingRoutesOptions> = (app, options) => {
  const principal = registerStreamingManagementAuth(app, options);
  const surfaces = [
    ["streams", "stream", "streaming_stream"],
    ["broadcasts", "broadcast", "broadcast_run"],
    ["recordings", "recording", "recording"],
    ["clips", "clip", "clip"],
    ["dvr-windows", "dvr", "dvr_window"],
    ["mixers", "mixer", "mixer"],
    ["restream-sources", "external-source", "restream_source"],
  ] as const;
  for (const [path, resourceType, table] of surfaces) {
    app.get(
      `/${path}/:resourceId/usage-report`,
      { schema: { response: { 200: z.toJSONSchema(serviceUsageReportSchema, { io: "input" }) } } },
      (request) =>
        options.database.transaction(async (db) => {
          const { resourceId } = validate(
            z.object({ resourceId: streamingIdSchema }),
            request.params,
          );
          const query = validate(serviceUsageQuerySchema, request.query);
          const [resource] = await db.execute(
            sql`SELECT * FROM ${sql.identifier(table)} WHERE id=${resourceId}`,
          );
          if (!resource) throw missing();
          const [recording] =
            resourceType === "clip" || resourceType === "dvr"
              ? await db.execute(
                  sql`SELECT * FROM recording WHERE id=${String(resource.recording_id)}`,
                )
              : [];
          if (resourceType === "recording" && resource.kind !== "recording") throw missing();
          const stream = await getStream(
            db,
            resourceType === "stream"
              ? resourceId
              : String(recording?.stream_id ?? resource.stream_id),
          );
          if (
            (query.projectId && query.projectId !== stream.projectId) ||
            (query.environmentId && query.environmentId !== stream.environmentId)
          )
            throw missing();
          await authorize(db, principal(request), stream, "usage:read");
          return getServiceUsage(
            db,
            {
              organizationId: stream.organizationId,
              projectId: stream.projectId,
              environmentId: stream.environmentId,
              streamId: stream.id,
              ...(resourceType === "stream"
                ? {}
                : resourceType === "dvr"
                  ? { resourceType, resourceIds: [resourceId, String(resource.recording_id)] }
                  : {
                      resourceType,
                      resourceId:
                        resourceType === "clip" ? String(resource.recording_id) : resourceId,
                    }),
            },
            query,
          );
        }),
    );
  }
  return Promise.resolve();
};
