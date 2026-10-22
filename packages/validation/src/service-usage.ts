import { z } from "zod";
import { serviceUsageDefinitions, serviceUsageRules } from "@relayrtc/types";

export const serviceUsageMetricsSchema = z.object(
  Object.fromEntries(
    Object.keys(serviceUsageDefinitions).map((name) => [
      name,
      z.number().nonnegative().refine(Number.isFinite),
    ]),
  ),
);
export const serviceUsageQuerySchema = z
  .object({
    range: z.enum(["live", "24h", "7d", "14d", "30d"]).optional(),
    startedAt: z.iso.datetime().optional(),
    endedAt: z.iso.datetime().optional(),
    granularity: z.enum(["hour", "day"]).optional(),
    projectId: z.string().optional(),
    environmentId: z.string().optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if ((q.startedAt === undefined) !== (q.endedAt === undefined) || (q.range && q.startedAt))
      ctx.addIssue({ code: "custom", message: "Choose a range or both UTC window boundaries." });
    if (
      q.startedAt &&
      q.endedAt &&
      (Date.parse(q.endedAt) <= Date.parse(q.startedAt) ||
        Date.parse(q.endedAt) - Date.parse(q.startedAt) > 30 * 86400000)
    )
      ctx.addIssue({
        code: "custom",
        message: "Usage windows must be positive and at most 30 days.",
      });
  });
const coverage = z.enum(["observed", "estimated", "partial", "unavailable"]);
const metricCoverage = z.object(
  Object.fromEntries(Object.keys(serviceUsageDefinitions).map((key) => [key, coverage])),
);
const metricDefinition = z.object({
  category: z.string(),
  unit: z.string(),
  attribution: z.string(),
  aggregation: z.string(),
  definition: z.string(),
  source: z.string(),
  pricing: z.literal("unpriced"),
});
export const serviceUsageReportSchema = z.object({
  window: z.object({
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    timezone: z.literal("UTC"),
    endExclusive: z.literal(true),
    granularity: z.enum(["hour", "day"]),
  }),
  summary: serviceUsageMetricsSchema,
  metricDefinitions: z.object(
    Object.fromEntries(Object.keys(serviceUsageDefinitions).map((key) => [key, metricDefinition])),
  ),
  rules: z.object(
    Object.fromEntries(Object.keys(serviceUsageRules).map((key) => [key, z.string()])),
  ),
  buckets: z.array(
    z.object({
      startedAt: z.iso.datetime(),
      endedAt: z.iso.datetime(),
      metrics: serviceUsageMetricsSchema,
    }),
  ),
  coverage: metricCoverage,
  journalStartedAt: z.iso.datetime(),
  historicalCoverage: z.enum(["complete", "partial"]),
  deliveryAuthority: z.literal("origin"),
  pricing: z.literal("unpriced"),
  resources: z.array(
    z.object({
      resourceType: z.string(),
      resourceId: z.string(),
      streamId: z.string(),
      metrics: serviceUsageMetricsSchema,
      metricCoverage,
      coverage,
    }),
  ),
  projects: z.array(
    z.object({
      projectId: z.string(),
      metrics: serviceUsageMetricsSchema,
      metricCoverage,
      coverage,
    }),
  ),
  resourceLimit: z.literal(100),
  resourcesTruncated: z.boolean(),
});
export type ServiceUsageReport = z.infer<typeof serviceUsageReportSchema>;
export type ServiceUsageQuery = z.infer<typeof serviceUsageQuerySchema>;
