import type { RelayKitDatabase } from "@relayrtc/database";
import {
  publicUsageQuerySchema,
  publicUsageResponseSchema,
  type PublicUsageCategory,
} from "@relayrtc/validation";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";

import { requireApiKeyScope } from "../../authentication/authentication-plugin.js";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import {
  authorizeProjectReport,
  createReportingAccessRepository,
} from "../reporting/reporting-access.js";
import { getPublicUsage } from "./usage.service.js";

export const usageRoutes: FastifyPluginCallback<{
  database: RelayKitDatabase;
  retentionDays?: number;
}> = (app, options, done) => {
  const repository = createReportingAccessRepository(options.database);
  const categories: PublicUsageCategory[] = [
    "all",
    "rooms",
    "participants",
    "sfu",
    "turn",
    "signaling",
    "screen-share",
    "streaming",
  ];
  for (const category of categories) {
    app.get(
      category === "all" ? "/usage" : `/usage/${category}`,
      {
        preHandler: requireApiKeyScope("usage:read"),
        schema: { response: { 200: z.toJSONSchema(publicUsageResponseSchema, { io: "input" }) } },
      },
      async (request, reply) => {
        reply.header("cache-control", "private, no-store");
        const key = request.apiKey;
        if (!key) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Provide a valid API key");
        const query = validate(publicUsageQuerySchema, request.query);
        const scope = await authorizeProjectReport(
          repository,
          { type: "apiKey", key },
          query.projectId ?? key.projectId,
          query.environmentId,
          "usage:read",
        );
        return getPublicUsage(
          options.database,
          { ...scope, environmentId: key.environmentId },
          query,
          category,
          new Date(),
          options.retentionDays,
        );
      },
    );
  }
  done();
};
