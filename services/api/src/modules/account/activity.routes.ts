import { activityViews, listActivity, inspectActivity, ActivityResourceNotFoundError, type ActivityContext } from "@relayrtc/auth/activity";
import { inspectStreamFeatures, inspectAssetFeatures } from "@relayrtc/auth/activity-features";
import type { RelayKitDatabase } from "@relayrtc/database";
import { projectIdSchema, environmentIdSchema } from "@relayrtc/validation";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { validate } from "../../http/validation/validate.js";
import { ApiError } from "../../http/errors/api-error.js";
import { authorizeRtcProject, authorizeRtcEnvironment } from "./rtc-access.js";

const params = z.object({ projectId: projectIdSchema, environmentId: environmentIdSchema });
const query = z.object({ view: z.enum(activityViews).default("rooms"), page: z.coerce.number().int().min(0).max(1000).default(0), search: z.string().trim().max(120).default(""), assetKind: z.enum(["all", "recording", "clip", "buffer"]).default("all") }).strict();
const root = "/api/account/activity/projects/:projectId/environments/:environmentId";
export function registerActivityRoutes(app: FastifyInstance, options: { database: RelayKitDatabase; current: (request: FastifyRequest) => Promise<{ user: { id: string } }> }) {
  async function scoped<T>(request: FastifyRequest, run: (db: Pick<RelayKitDatabase, "select">, context: ActivityContext) => Promise<T>) {
    request.raw.setTimeout?.(25000);
    const path = validate(params, request.params), { user } = await options.current(request);
    try {
      return await options.database.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        const access = await authorizeRtcProject(tx, user.id, path.projectId);
        const environment = await authorizeRtcEnvironment(tx, path.projectId, path.environmentId);
        return run(tx, { orgId: access.project.organizationId, projectId: path.projectId, environment: { id: environment.id } });
      });
    } catch (error) {
      if (error instanceof ActivityResourceNotFoundError) throw new ApiError(404, "ACTIVITY_RESOURCE_NOT_FOUND", "This activity resource is unavailable or you no longer have access.");
      throw error;
    }
  }
  app.get(root, async request => {
    const q = validate(query, request.query);
    return scoped(request, async (database, context) => ({ ...await listActivity(database, context, q.view, q.page, q.search, q.assetKind), page: q.page, observedAt: new Date().toISOString() }));
  });
  app.get(`${root}/:view/:resourceId`, async request => {
    const { view, resourceId } = validate(params.extend({ view: z.enum(activityViews), resourceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u) }), request.params);
    const { page } = validate(z.object({ page: query.shape.page }).strict(), request.query);
    return scoped(request, async (database, context) => {
      const result = await inspectActivity(database, context, view, resourceId, page);
      const groups = view === "streams" ? await inspectStreamFeatures(database, context, resourceId, page) : view === "assets" ? await inspectAssetFeatures(database, context, resourceId) : [];
      return { ...result, groups, hasNext: result.hasNext || groups.some(group => group.hasNext), page, observedAt: new Date().toISOString() };
    });
  });
}
