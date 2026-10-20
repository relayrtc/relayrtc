import { serviceUsageReportSchema } from "./service-usage.js";
import { z } from "zod";

import { environmentIdSchema, organizationIdSchema, projectIdSchema } from "./common.js";
import {
  reportingUsageMetricsSchema,
  usageDataQualitySchema,
  usageRangeSchema,
} from "./reporting.js";

const timestamp = z.iso.datetime({ precision: 3 });
export const publicUsageQuerySchema = z
  .object({
    range: usageRangeSchema.optional(),
    startedAt: z.iso.datetime().optional(),
    endedAt: z.iso.datetime().optional(),
    granularity: z.enum(["hour", "day"]).optional(),
    projectId: projectIdSchema.optional(),
    environmentId: environmentIdSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if ((query.startedAt === undefined) !== (query.endedAt === undefined)) {
      context.addIssue({ code: "custom", message: "Provide both window boundaries" });
    }
    if (query.range !== undefined && query.startedAt !== undefined) {
      context.addIssue({ code: "custom", message: "Choose a range or explicit boundaries" });
    }
    if (query.startedAt !== undefined && query.endedAt !== undefined) {
      const duration = Date.parse(query.endedAt) - Date.parse(query.startedAt);
      if (duration <= 0 || duration > 30 * 86400_000) {
        context.addIssue({
          code: "custom",
          message: "Usage windows must be positive and at most 30 days",
        });
      }
    }
  });

export const publicUsageMetricsSchema = reportingUsageMetricsSchema
  .omit({ messagesIn: true, messagesOut: true })
  .extend({
    participantMinutesDerived: z.number().nonnegative(),
    signalingMessagesIn: z.number().int().nonnegative(),
    signalingMessagesOut: z.number().int().nonnegative(),
    turnRelaySeconds: z.number().nonnegative(),
    turnSessions: z.number().int().nonnegative(),
  })
  .partial();

export const publicUsageResponseSchema = z
  .object({
    scope: z
      .object({
        organizationId: organizationIdSchema,
        projectId: projectIdSchema,
        environmentId: environmentIdSchema,
      })
      .strict(),
    category: z.enum(["all", "rooms", "participants", "sfu", "turn", "signaling", "screen-share", "streaming"]),
    window: z
      .object({
        range: z.union([usageRangeSchema, z.literal("custom")]),
        startedAt: timestamp,
        endedAt: timestamp,
        timezone: z.literal("UTC"),
        endExclusive: z.literal(true),
      })
      .strict(),
    bucketDefinition: z
      .object({
        granularity: z.enum(["hour", "day"]),
        alignment: z.literal("UTC calendar boundaries"),
        partialEdges: z.literal("clipped to requested window"),
        durations: z.literal("lifecycle intervals clipped to each bucket"),
        events: z.literal("attributed to occurrence time"),
      })
      .strict(),
    metricDefinitions: z
      .object(
        Object.fromEntries(
          Object.keys(publicUsageMetricsSchema.shape).map((metric) => [
            metric,
            z
              .object({
                unit: z.enum(["seconds", "minutes", "bytes", "count", "participants"]),
                aggregation: z.enum([
                  "sum",
                  "union_seconds",
                  "count",
                  "peak",
                  "time_weighted_average",
                  "derived",
                  "gauge",
                ]),
                integer: z.boolean(),
                definition: z.string(),
                source: z.string(),
              })
              .strict(),
          ]),
        ),
      )
      .partial()
      .strict(),
    serviceUsage: serviceUsageReportSchema.optional(),
    summary: publicUsageMetricsSchema,
    buckets: z
      .array(
        z
          .object({ startedAt: timestamp, endedAt: timestamp, metrics: publicUsageMetricsSchema })
          .strict(),
      )
      .max(721),
    dataQuality: usageDataQualitySchema.extend({ mediaDurations: z.literal("observation_time") }),
  })
  .strict();

export type PublicUsageQuery = z.infer<typeof publicUsageQuerySchema>;
export type PublicUsageResponse = z.infer<typeof publicUsageResponseSchema>;
export type PublicUsageCategory = PublicUsageResponse["category"];
