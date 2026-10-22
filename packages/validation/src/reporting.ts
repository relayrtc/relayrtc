import { serviceUsageReportSchema } from "./service-usage.js";
import { z } from "zod";

import { environmentIdSchema, organizationIdSchema, projectIdSchema } from "./common.js";
import { usageMetricValueSchema } from "./usage.js";

export const usageRangeSchema = z.enum(["24h", "7d", "14d", "30d"]);
export const analyticsRangeSchema = z.enum(["live", "24h", "7d", "30d"]);
export const reportingProjectParamsSchema = z.object({ projectId: projectIdSchema }).strict();
export const reportingOrganizationParamsSchema = z
  .object({ organizationId: organizationIdSchema })
  .strict();
export const projectUsageQuerySchema = z
  .object({
    range: usageRangeSchema.default("7d"),
    environmentId: environmentIdSchema.optional(),
  })
  .strict();
export const projectAnalyticsQuerySchema = z
  .object({
    range: analyticsRangeSchema.default("7d"),
    environmentId: environmentIdSchema.optional(),
  })
  .strict();
export const organizationUsageQuerySchema = z
  .object({
    range: usageRangeSchema.default("7d"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();
export const quotaQuerySchema = z.object({}).strict();

const quantity = z.number().nonnegative();
const count = quantity.int();
const percentage = quantity.max(100);
const timestamp = z.iso.datetime({ offset: false });
export const reportingWindowSchema = z
  .object({
    range: z.union([usageRangeSchema, analyticsRangeSchema]),
    startedAt: timestamp,
    endedAt: timestamp,
    timezone: z.literal("UTC"),
    endExclusive: z.literal(true),
  })
  .strict()
  .refine((window) => Date.parse(window.startedAt) < Date.parse(window.endedAt), {
    message: "The reporting window must have positive duration",
  });
export const reportingUsageMetricsSchema = z
  .object({
    participantSeconds: usageMetricValueSchema("participantSeconds"),
    audioParticipantSeconds: usageMetricValueSchema("audioParticipantSeconds"),
    videoParticipantSeconds: usageMetricValueSchema("videoParticipantSeconds"),
    screenShareSeconds: usageMetricValueSchema("screenShareSeconds"),
    screenShareIngressBytes: quantity,
    screenShareEgressBytes: quantity,
    sfuIngressBytes: quantity,
    sfuEgressBytes: quantity,
    turnIngressBytes: quantity,
    turnEgressBytes: quantity,
    turnRelaySeconds: quantity.default(0),
    turnSessions: count.default(0),
    roomsCreated: usageMetricValueSchema("roomsCreated"),
    roomsStarted: usageMetricValueSchema("roomsStarted"),
    roomSeconds: usageMetricValueSchema("roomSeconds"),
    averageConcurrentParticipants: usageMetricValueSchema("averageConcurrentParticipants"),
    peakConcurrentParticipants: usageMetricValueSchema("peakConcurrentParticipants"),
    peakConcurrentRooms: usageMetricValueSchema("peakConcurrentRooms"),
    signalingConnections: usageMetricValueSchema("signalingConnections"),
    signalingConnectionSeconds: usageMetricValueSchema("signalingConnectionSeconds"),
    messagesIn: usageMetricValueSchema("messagesIn"),
    messagesOut: usageMetricValueSchema("messagesOut"),
  })
  .strict();
export const usageBucketSchema = z
  .object({
    startedAt: timestamp,
    endedAt: timestamp,
    participantSeconds: quantity,
    roomsCreated: count,
  })
  .strict();
const projectScope = {
  organizationId: organizationIdSchema,
  projectId: projectIdSchema,
  environmentId: environmentIdSchema.nullable(),
};
export const usageDataQualitySchema = z
  .object({
    sessionHistory: z.enum(["complete", "partial"]),
    messageHistory: z.enum(["complete", "partial"]),
    turnTraffic: z.enum(["unavailable", "partial", "authoritative"]).default("unavailable"),
  })
  .strict();
export const projectUsageResponseSchema = z
  .object({
    serviceUsage: serviceUsageReportSchema.optional(),
    scope: z.object(projectScope).strict(),
    window: reportingWindowSchema,
    summary: reportingUsageMetricsSchema,
    buckets: z.array(usageBucketSchema),
    dataQuality: usageDataQualitySchema,
  })
  .strict();
export const organizationUsageResponseSchema = z
  .object({
    organizationId: organizationIdSchema,
    serviceUsage: serviceUsageReportSchema.optional(),
    window: reportingWindowSchema,
    summary: reportingUsageMetricsSchema,
    projects: z.array(
      z
        .object({
          projectId: projectIdSchema,
          summary: reportingUsageMetricsSchema,
          dataQuality: usageDataQualitySchema,
        })
        .strict(),
    ),
    pagination: z.object({ limit: count, offset: count, total: count }).strict(),
    dataQuality: usageDataQualitySchema,
  })
  .strict();
export const organizationQuotaResponseSchema = z
  .object({
    organizationId: organizationIdSchema,
    status: z.literal("unconfigured"),
    limits: z.array(z.never()),
  })
  .strict();
const seriesPoint = { startedAt: timestamp, endedAt: timestamp };
const network = z
  .object({
    sfuIngressBytes: quantity,
    sfuEgressBytes: quantity,
    turnIngressBytes: quantity,
    turnEgressBytes: quantity,
  })
  .strict();
export const projectAnalyticsResponseSchema = z
  .object({
    serviceUsage: serviceUsageReportSchema.optional(),
    scope: z.object(projectScope).strict(),
    window: reportingWindowSchema,
    summary: z
      .object({
        peakConcurrent: count,
        totalSessions: count,
        averageSessionSeconds: quantity,
        participantSeconds: quantity,
        connectionSuccessRate: percentage,
      })
      .strict(),
    network,
    dataQuality: usageDataQualitySchema,
    qualityGranularitySeconds: z.literal(60),
    traffic: z.array(
      z
        .object({
          ...seriesPoint,
          participants: count,
          sessions: count,
          participantSeconds: quantity,
        })
        .strict(),
    ),
    networkSeries: z.array(z.object({ ...seriesPoint, ...network.shape }).strict()),
    quality: z.array(
      z
        .object({
          ...seriesPoint,
          roundTripTimeMs: quantity.nullable(),
          jitterMs: quantity.nullable(),
          packetLossPercent: percentage.nullable(),
          sampleCount: count,
        })
        .strict(),
    ),
    regions: z.array(z.object({ name: z.string(), sessions: count }).strict()),
    qualityDistribution: z.array(
      z
        .object({
          quality: z.enum(["excellent", "good", "poor", "critical", "lost"]),
          count,
        })
        .strict(),
    ),
    topRooms: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string(),
            participants: count,
            participantSeconds: quantity,
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

export type ProjectUsageResponse = z.infer<typeof projectUsageResponseSchema>;
export type OrganizationUsageResponse = z.infer<typeof organizationUsageResponseSchema>;
export type OrganizationQuotaResponse = z.infer<typeof organizationQuotaResponseSchema>;
export type ProjectAnalyticsResponse = z.infer<typeof projectAnalyticsResponseSchema>;
