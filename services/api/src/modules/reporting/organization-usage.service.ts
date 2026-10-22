import { getServiceUsage } from "./service-usage-report.js";
import type { RelayKitDatabase } from "@relayrtc/database";
import {
  organizationUsageResponseSchema,
  type OrganizationUsageResponse,
} from "@relayrtc/validation";

import { createUsageReportQuery, usageDataQuality, type UsageRange } from "./usage-query.js";

export async function getOrganizationUsage(
  database: RelayKitDatabase,
  organizationId: string,
  options: { range: UsageRange; limit: number; offset: number },
  endedAt = new Date(),
): Promise<OrganizationUsageResponse> {
  const { query, window } = createUsageReportQuery(
    { organizationId, projectId: null, environmentId: null },
    options.range,
    endedAt,
    options,
  );
  const result = await database.execute(query);
  const row = result[0] as
    { summary: unknown; projects: unknown; total: string | number; complete: boolean; turn_coverage?: unknown } | undefined;
  return organizationUsageResponseSchema.parse({
    organizationId,
    serviceUsage: await getServiceUsage(database, { organizationId, projectId: null, environmentId: null }, { startedAt: window.startedAt, endedAt: window.endedAt }, endedAt),
    window,
    summary: row?.summary,
    projects: row?.projects,
    pagination: { limit: options.limit, offset: options.offset, total: Number(row?.total) },
    dataQuality: usageDataQuality(row?.complete, row?.turn_coverage),
  });
}
