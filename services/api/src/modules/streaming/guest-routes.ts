import { sql } from "drizzle-orm";
import { z } from "zod";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { recordAudit, type AuditActor } from "@relayrtc/auth/server";
import { signStreamingGrant, verifyStreamingGrant } from "@relayrtc/protocol/streaming-control";
import {
  guestQuerySchema,
  guestStageSchema,
  audienceGrantSchema,
  inviteGuestSchema,
  guestRequestSchema,
  guestDecisionSchema,
  guestMuteSchema,
  streamingIdSchema,
} from "@relayrtc/validation";
import { validate } from "../../http/validation/validate.js";
import { ApiError } from "../../http/errors/api-error.js";
import {
  createParticipantTokenSigner,
  type ParticipantTokenSignerConfig,
} from "../participant-tokens/participant-token.signer.js";
import type { StreamingRoutesOptions } from "./routes.js";
import { registerStreamingManagementAuth } from "./management-auth.js";
import {
  authorize,
  getStream,
  id,
  idempotent,
  conflict,
  missing,
  type Transaction,
} from "./repository.js";
import { getBroadcast } from "./broadcast-service.js";
import {
  getGuest,
  publicGuest,
  guestRowSchema,
  guestEvent,
  guestCapacity,
  type GuestRow,
} from "./guest-service.js";
import { guestOpenApi } from "./guest-openapi.js";
const audienceRow = z.object({
  id: z.string(),
  subject: z.string(),
  name: z.string(),
  role: z.enum(["host", "cohost", "moderator", "guest", "viewer"]),
  delegations: z.array(z.enum(["invite", "approve", "moderate"])),
  epoch: z.number(),
});
const stageRowSchema = z.object({
  broadcast_id: z.string(),
  stream_id: z.string(),
  room_id: z.string(),
  enabled: z.boolean(),
  version: z.number(),
  max_guests: z.number(),
  layout: z.enum(["grid", "single", "pip"]),
});
export const guestRoutes: FastifyPluginAsync<
  StreamingRoutesOptions & { participantSigner: ParticipantTokenSignerConfig }
> = (app, options) => {
  const { database, config } = options,
    signer = createParticipantTokenSigner(options.participantSigner);
  const principal = registerStreamingManagementAuth(app, {
    ...options,
    acceptAudienceToken: (token) =>
      !!verifyStreamingGrant(config.secret, token, "streaming-audience"),
  });
  const scoped = async (db: Transaction, request: FastifyRequest, write = false) => {
    const path = validate(
        z.object({
          streamId: streamingIdSchema,
          guestId: streamingIdSchema.optional(),
          inviteId: streamingIdSchema.optional(),
          requestId: streamingIdSchema.optional(),
        }),
        request.params,
      ),
      query = validate(guestQuerySchema, request.query);
    const stream = await getStream(db, path.streamId, write),
      run = await getBroadcast(db, query.broadcastId);
    if (
      run.streamId !== stream.id ||
      stream.status !== "active" ||
      (query.projectId && stream.projectId !== query.projectId) ||
      (query.environmentId && stream.environmentId !== query.environmentId)
    )
      throw missing();
    const token = /^Bearer (\S+)$/u.exec(request.headers.authorization ?? "")?.[1],
      claims = token ? verifyStreamingGrant(config.secret, token, "streaming-audience") : null;
    let audience: z.infer<typeof audienceRow> | null = null;
    let actor: AuditActor;
    if (claims) {
      if (claims.streamId !== stream.id || claims.sessionId !== run.id || claims.action !== "guest")
        throw missing();
      const [row] = await db.execute(
        sql`SELECT * FROM stream_audience WHERE id=${claims.sub} AND broadcast_id=${run.id} AND epoch=${claims.generation} AND expires_at>now()`,
      );
      if (!row)
        throw new ApiError(
          401,
          "AUDIENCE_GRANT_REVOKED",
          "Refresh your application audience identity.",
        );
      const [owner] = await db.execute(
        sql`SELECT p.id FROM project p JOIN environment e ON e.project_id=p.id JOIN organization o ON o.id=p.organization_id WHERE p.id=${stream.projectId} AND e.id=${stream.environmentId} AND p.status='active' AND e.status='active' AND o.status='active'`,
      );
      if (!owner)
        throw new ApiError(
          401,
          "AUDIENCE_OWNER_RETIRED",
          "This audience scope is no longer available.",
        );
      audience = audienceRow.parse(row);
      actor = {
        type: "USER",
        id: JSON.stringify({ audienceId: audience.id, subject: audience.subject }),
        name: audience.name,
      };
    } else
      actor = (
        await authorize(db, principal(request), stream, write ? "streams:write" : "streams:read")
      ).actor;
    const [stage] = await db.execute(
      sql`SELECT * FROM stream_guest_stage WHERE broadcast_id=${run.id} ${write ? sql`FOR UPDATE` : sql``}`,
    );
    const [room] = stage
      ? await db.execute(
          sql`SELECT id,status FROM room WHERE id=${String(stage.room_id)} ${write ? sql`FOR UPDATE` : sql``}`,
        )
      : [];
    const roomJoinable = room?.status === "created" || room?.status === "active";
    return {
      stream,
      roomJoinable,
      run,
      stage: stage ? stageRowSchema.parse(stage) : null,
      query,
      path,
      audience,
      actor,
    };
  };
  type Context = Awaited<ReturnType<typeof scoped>>;
  const operator = (c: Context, right: "invite" | "approve" | "moderate") => {
    if (
      c.audience &&
      c.audience.role !== "host" &&
      !(["cohost", "moderator"].includes(c.audience.role) && c.audience.delegations.includes(right))
    )
      throw new ApiError(
        403,
        "GUEST_CONTROL_FORBIDDEN",
        "This role has no delegated stage control.",
      );
  };
  const own = async (db: Transaction, c: Context, subject?: string) => {
    if (c.audience) {
      if (subject && subject !== c.audience.subject) throw missing();
      return c.audience;
    }
    if (!subject)
      throw new ApiError(
        400,
        "GUEST_SUBJECT_REQUIRED",
        "Backends must supply the authorized application subject.",
      );
    const [row] = await db.execute(
      sql`SELECT * FROM stream_audience WHERE broadcast_id=${c.run.id} AND subject=${subject}`,
    );
    if (!row) throw missing();
    return audienceRow.parse(row);
  };
  const running = (c: Context) => {
    if (
      !config.guestsEnabled ||
      !c.roomJoinable ||
      !c.stage?.enabled ||
      c.run.desiredState !== "running" ||
      ["stopping", "stopped", "failed"].includes(c.run.state)
    )
      throw conflict("GUEST_STAGE_UNAVAILABLE", "This run is not accepting stage guests.");
  };
  const command = (
    db: Transaction,
    c: Context,
    request: FastifyRequest,
    input: unknown,
    status: number,
    run: () => Promise<unknown>,
  ) =>
    idempotent(
      db,
      `${c.actor.type}:${c.actor.id ?? c.actor.name}:${request.method}:${request.url}`,
      typeof request.headers["idempotency-key"] === "string"
        ? request.headers["idempotency-key"]
        : undefined,
      input,
      status,
      run,
    );
  const throttle = async (db: Transaction, c: Context, subject: string) => {
    const [count] = await db.execute(
      sql`SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>now()-interval '1 minute')::int AS recent,count(*) FILTER(WHERE subject=${subject} AND created_at>now()-interval '1 minute')::int AS own FROM stream_guest WHERE broadcast_id=${c.run.id}`,
    );
    if (Number(count?.total) >= 1000 || Number(count?.recent) >= 100 || Number(count?.own) >= 5)
      throw new ApiError(
        429,
        "GUEST_REQUEST_LIMIT",
        "Guest request capacity is full. Try again later.",
      );
    const [existing] = await db.execute(
      sql`SELECT id FROM stream_guest WHERE broadcast_id=${c.run.id} AND subject=${subject} AND state IN ('pending','accepted','approved','joined')`,
    );
    if (existing)
      throw conflict(
        "GUEST_ALREADY_PENDING",
        "This audience member already has an open stage request or invitation.",
      );
  };
  app.get("/streams/:streamId/guest-stage", (request) =>
    database.transaction(async (db) => {
      const c = await scoped(db, request);
      return {
        enabled:
          !!c.stage?.enabled &&
          c.roomJoinable &&
          config.guestsEnabled &&
          c.run.desiredState === "running" &&
          !["stopping", "stopped", "failed"].includes(c.run.state),
        version: c.stage?.version ?? 0,
        maxGuests: c.stage?.max_guests ?? 3,
        layout: c.stage?.layout ?? "grid",
        roomId: c.stage?.room_id ?? "",
        occupied: Number(
          (
            await db.execute(
              sql`SELECT count(*)::int AS n FROM stream_guest WHERE broadcast_id=${c.run.id} AND state IN ('accepted','approved','joined') AND expires_at>now()`,
            )
          )[0]?.n ?? 0,
        ),
      };
    }),
  );
  app.put("/streams/:streamId/guest-stage", (request) => {
    const input = validate(guestStageSchema, request.body);
    return database.transaction(async (db) => {
      const c = await scoped(db, request, true);
      if (c.audience)
        throw new ApiError(
          403,
          "MANAGEMENT_REQUIRED",
          "Configure stages through your application backend.",
        );
      await authorize(db, principal(request), c.stream, "streams:publish");
      await authorize(db, principal(request), c.stream, "tokens:create");
      return command(db, c, request, input, 200, async () => {
        if (c.stream.source.kind !== "room")
          throw conflict(
            "GUEST_ROOM_SOURCE_REQUIRED",
            "Select a dedicated RTC room source for co-hosting.",
          );
        if (
          input.enabled &&
          (!config.guestsEnabled ||
            c.run.desiredState !== "running" ||
            ["stopping", "stopped", "failed"].includes(c.run.state))
        )
          throw conflict(
            "GUEST_STAGE_UNAVAILABLE",
            "Start the broadcast before enabling its stage.",
          );
        if ((c.stage?.version ?? 0) !== input.version)
          throw conflict("GUEST_VERSION_CONFLICT", "Reload the guest stage.");
        const [room] = await db.execute(
          sql`SELECT * FROM room WHERE id=${c.stream.source.roomId} AND project_id=${c.stream.projectId} AND environment_id=${c.stream.environmentId} AND status IN ('created','active') FOR UPDATE`,
        );
        if (
          !room ||
          Number(room.max_participants) < input.maxGuests + 1 ||
          Number(room.max_participants) > 4
        )
          throw conflict(
            "GUEST_ROOM_CAPACITY",
            "Use a dedicated room with at most four seats and at least one host seat plus the requested guest slots.",
          );
        const [occupied] = await db.execute(
          sql`SELECT count(*)::int AS n FROM stream_guest WHERE broadcast_id=${c.run.id} AND state IN ('accepted','approved','joined') AND expires_at>now()`,
        );
        if (
          input.enabled &&
          (Number(occupied?.n) > input.maxGuests || (input.layout === "pip" && input.maxGuests > 1))
        )
          throw conflict(
            "GUEST_LAYOUT_CAPACITY",
            "Choose a layout/capacity that fits the reserved stage.",
          );
        if (c.stage && c.stage.room_id !== c.stream.source.roomId)
          throw conflict(
            "GUEST_SOURCE_CHANGED",
            "Create a new broadcast after changing its stage room.",
          );
        const [parallel] = await db.execute(
          sql`SELECT id FROM broadcast_run WHERE stream_id=${c.stream.id} AND id<>${c.run.id} AND desired_state='running' AND state NOT IN ('stopping','stopped','failed')`,
        );
        if (input.enabled && parallel)
          throw conflict(
            "GUEST_PROGRAM_RESERVED",
            "Another running broadcast shares this program. Stop it before enabling co-hosting.",
          );
        const [other] = await db.execute(
          sql`SELECT broadcast_id FROM stream_guest_stage WHERE room_id=${c.stream.source.roomId} AND enabled AND broadcast_id<>${c.run.id}`,
        );
        const [mixer] = await db.execute(
          sql`SELECT id,broadcast_id FROM mixer WHERE stream_id=${c.stream.id} AND desired_state='running'`,
        );
        if (input.enabled && (other || (mixer && mixer.broadcast_id !== c.run.id)))
          throw conflict(
            "GUEST_PROGRAM_RESERVED",
            "This room or program is already reserved by another studio.",
          );
        await db.execute(
          sql`INSERT INTO stream_guest_stage(broadcast_id,stream_id,room_id,enabled,version,max_guests,layout) VALUES(${c.run.id},${c.stream.id},${c.stream.source.roomId},${input.enabled},${input.version + 1},${input.maxGuests},${input.layout}) ON CONFLICT(broadcast_id) DO UPDATE SET enabled=excluded.enabled,version=excluded.version,max_guests=excluded.max_guests,layout=excluded.layout`,
        );
        await recordAudit(db, {
          actor: c.actor,
          action: "stream.guest.stage.updated",
          outcome: "SUCCESS",
          organizationId: c.stream.organizationId,
          resourceType: "stream_guest_stage",
          resourceId: c.run.id,
          correlationId: request.id,
        });
        return {
          ...input,
          version: input.version + 1,
          roomId: c.stream.source.roomId,
          occupied: input.enabled ? Number(occupied?.n ?? 0) : 0,
        };
      });
    });
  });
  app.post("/streams/:streamId/audience-grants", async (request, reply) => {
    const input = validate(audienceGrantSchema, request.body);
    const result = await database.transaction(async (db) => {
      const c = await scoped(db, request, true);
      if (c.audience)
        throw new ApiError(
          403,
          "MANAGEMENT_REQUIRED",
          "Audience identities are issued by application backends.",
        );
      await authorize(db, principal(request), c.stream, "tokens:create");
      await authorize(db, principal(request), c.stream, "streams:publish");
      running(c);
      if (input.delegations.length && !["cohost", "moderator"].includes(input.role))
        throw conflict(
          "GUEST_DELEGATION_ROLE",
          "Only co-hosts and moderators accept delegated controls.",
        );
      const [identity] = await db.execute(
        sql`SELECT id FROM stream_audience WHERE broadcast_id=${c.run.id} AND subject=${input.subject}`,
      );
      if (!identity) {
        const [count] = await db.execute(
          sql`SELECT count(*)::int AS n FROM stream_audience WHERE broadcast_id=${c.run.id}`,
        );
        if (Number(count?.n) >= 10000)
          throw conflict(
            "AUDIENCE_CAPACITY",
            "This broadcast has reached its audience identity capacity.",
          );
      }
      const [row] = await db.execute(
        sql`INSERT INTO stream_audience(id,broadcast_id,subject,name,role,delegations,expires_at) VALUES(${id("audience")},${c.run.id},${input.subject},${input.name},${input.role},${JSON.stringify(input.delegations)}::jsonb,now()+make_interval(secs=>${input.ttlSeconds})) ON CONFLICT(broadcast_id,subject) DO UPDATE SET expires_at=excluded.expires_at,name=excluded.name,role=excluded.role,delegations=excluded.delegations,epoch=stream_audience.epoch+CASE WHEN stream_audience.role<>excluded.role OR stream_audience.delegations<>excluded.delegations THEN 1 ELSE 0 END RETURNING *`,
      );
      const a = audienceRow.parse(row);
      await recordAudit(db, {
        actor: c.actor,
        action: "stream.audience.granted",
        outcome: "SUCCESS",
        organizationId: c.stream.organizationId,
        resourceType: "stream_audience",
        resourceId: a.id,
      });
      return {
        token: signStreamingGrant(
          config.secret,
          {
            aud: "streaming-audience",
            sub: a.id,
            streamId: c.stream.id,
            sessionId: c.run.id,
            action: "guest",
            generation: a.epoch,
          },
          input.ttlSeconds,
        ),
        expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
        audienceId: a.id,
      };
    });
    return reply.code(201).send(result);
  });
  for (const kind of ["invite", "request"] as const) {
    const collection = kind === "invite" ? "invites" : "guest-requests";
    app.post(`/streams/:streamId/${collection}`, async (request, reply) => {
      const input =
        kind === "invite"
          ? validate(inviteGuestSchema, request.body)
          : validate(guestRequestSchema, request.body);
      const result = await database.transaction(async (db) => {
        const c = await scoped(db, request, true);
        running(c);
        if (kind === "invite") operator(c, "invite");
        const a =
          kind === "request"
            ? await own(db, c, "subject" in input ? input.subject : undefined)
            : null;
        const subject = a?.subject ?? ("recipientSubject" in input ? input.recipientSubject : "");
        return command(db, c, request, input, 201, async () => {
          await throttle(db, c, subject);
          const key = id("guest"),
            ttl = "ttlSeconds" in input ? input.ttlSeconds : 300;
          await db.execute(
            sql`INSERT INTO stream_guest(id,broadcast_id,subject,name,kind,media,actor_id,expires_at) VALUES(${key},${c.run.id},${subject},${a?.name ?? subject.slice(0, 80)},${kind},${JSON.stringify(input.media)}::jsonb,${c.actor.id ?? c.actor.name},now()+make_interval(secs=>${ttl}))`,
          );
          const g = await getGuest(db, key, c.run.id);
          await guestEvent(db, g, kind === "invite" ? "invited" : "requested", c.actor);
          return publicGuest(g, !c.audience);
        });
      });
      return reply.code(201).send(result);
    });
  }
  for (const collection of ["invites", "guest-requests", "guests", "guest-status"]) {
    app.get(`/streams/:streamId/${collection}`, (request) =>
      database.transaction(async (db) => {
        const c = await scoped(db, request);
        if (!c.stage) throw missing();
        const op =
          !c.audience ||
          c.audience.role === "host" ||
          (["cohost", "moderator"].includes(c.audience.role) && c.audience.delegations.length > 0);
        const filter =
          collection === "invites"
            ? sql`AND kind='invite'`
            : collection === "guest-requests"
              ? sql`AND kind='request'`
              : collection === "guests"
                ? sql`AND state IN ('accepted','approved','joined') AND expires_at>now()`
                : sql``;
        if (collection === "guest-status" && !c.audience && !c.query.subject)
          throw new ApiError(
            400,
            "GUEST_SUBJECT_REQUIRED",
            "Choose the authorized application subject for its status.",
          );
        if (c.audience && c.query.subject && c.query.subject !== c.audience.subject)
          throw missing();
        const privacy =
          collection === "guest-status"
            ? sql`AND subject=${c.audience?.subject ?? c.query.subject ?? ""}`
            : c.audience
              ? !op && collection !== "guests"
                ? sql`AND subject=${c.audience.subject}`
                : !op
                  ? sql`AND (state='joined' OR subject=${c.audience.subject})`
                  : sql``
              : sql``;
        const rows = await db.execute(
            sql`SELECT * FROM stream_guest WHERE broadcast_id=${c.run.id} ${filter} ${privacy} ${c.query.cursor ? sql`AND (created_at,id)<(SELECT created_at,id FROM stream_guest WHERE broadcast_id=${c.run.id} AND id=${c.query.cursor})` : sql``} ORDER BY created_at DESC,id DESC LIMIT ${c.query.limit + 1}`,
          ),
          more = rows.length > c.query.limit,
          data = rows.slice(0, c.query.limit).map((r) => publicGuest(guestRowSchema.parse(r), op));
        const [occupied] = await db.execute(
          sql`SELECT count(*)::int AS n FROM stream_guest WHERE broadcast_id=${c.run.id} AND state IN ('accepted','approved','joined') AND expires_at>now()`,
        );
        return {
          data,
          nextCursor: more ? (data.at(-1)?.id ?? null) : null,
          stage: {
            enabled:
              c.stage.enabled &&
              c.roomJoinable &&
              config.guestsEnabled &&
              c.run.desiredState === "running" &&
              !["stopping", "stopped", "failed"].includes(c.run.state),
            version: c.stage.version,
            maxGuests: c.stage.max_guests,
            layout: c.stage.layout,
            roomId: c.stage.room_id,
            occupied: Number(occupied?.n ?? 0),
          },
        };
      }),
    );
  }
  const decisions = [
    ["invites", "inviteId", "accept"],
    ["invites", "inviteId", "decline"],
    ["invites", "inviteId", "cancel"],
    ["guest-requests", "requestId", "approve"],
    ["guest-requests", "requestId", "reject"],
    ["guests", "guestId", "leave"],
    ["guests", "guestId", "remove"],
    ["guests", "guestId", "mute"],
  ] as const;
  for (const [collection, param, action] of decisions)
    app.post(`/streams/:streamId/${collection}/:${param}/${action}`, (request) => {
      const input =
        action === "mute"
          ? validate(guestMuteSchema, request.body)
          : validate(guestDecisionSchema, request.body);
      return database.transaction(async (db) => {
        const c = await scoped(db, request, true),
          key = c.path[param];
        if (!key) throw missing();
        let g = await getGuest(db, key, c.run.id, true);
        if (["accept", "decline", "leave"].includes(action)) {
          const a = await own(db, c, input.subject);
          if (a.subject !== g.subject) throw missing();
        } else
          operator(
            c,
            action === "cancel"
              ? "invite"
              : action === "approve" || action === "reject"
                ? "approve"
                : "moderate",
          );
        return command(db, c, request, input, 200, async () => {
          if (action === "leave" && g.state === "left") return publicGuest(g, !c.audience);
          if (g.version !== input.version)
            throw conflict("GUEST_VERSION_CONFLICT", "Refresh the guest state.");
          if (
            g.expires_at.getTime() <= Date.now() ||
            ["expired", "left", "removed", "cancelled", "declined", "rejected"].includes(g.state)
          )
            throw conflict("GUEST_DECISION_EXPIRED", "This stage action is no longer available.");
          let state: GuestRow["state"], event: string;
          if (["accept", "decline", "cancel", "approve", "reject"].includes(action)) {
            if (g.state !== "pending" || (collection === "invites") !== (g.kind === "invite"))
              throw conflict(
                "GUEST_STATE_CONFLICT",
                "This invitation or request has already been decided.",
              );
            if (action === "accept" || action === "approve") {
              running(c);
              if (!c.stage) throw missing();
              await guestCapacity(db, c.run.id, c.stage.room_id, c.stage.max_guests);
            }
            state =
              action === "accept"
                ? "accepted"
                : action === "approve"
                  ? "approved"
                  : action === "decline"
                    ? "declined"
                    : action === "reject"
                      ? "rejected"
                      : "cancelled";
            event =
              action === "accept"
                ? "invite_accepted"
                : action === "approve"
                  ? "request_approved"
                  : action === "decline"
                    ? "invite_declined"
                    : action === "reject"
                      ? "request_rejected"
                      : "invite_cancelled";
          } else {
            if (!["accepted", "approved", "joined"].includes(g.state))
              throw conflict("GUEST_STATE_CONFLICT", "This guest has no active stage reservation.");
            state = action === "leave" ? "left" : action === "remove" ? "removed" : "accepted";
            event = action === "mute" ? "muted" : action === "remove" ? "removed" : "left";
          }
          const audio = "audio" in input ? (input.audio ?? g.muted_audio) : g.muted_audio,
            video = "video" in input ? (input.video ?? g.muted_video) : g.muted_video;
          await db.execute(
            sql`UPDATE stream_guest SET state=${state},version=version+1,participant_id=CASE WHEN ${action === "mute"} THEN NULL ELSE participant_id END,decided_by=${c.actor.id ?? c.actor.name},muted_audio=${audio},muted_video=${video},expires_at=CASE WHEN ${["accepted", "approved"].includes(state)} THEN now()+interval '120 seconds' ELSE expires_at END WHERE id=${g.id}`,
          );
          g = await getGuest(db, g.id, c.run.id);
          await guestEvent(db, g, event, c.actor);
          if (["mute", "remove", "leave"].includes(action))
            await guestEvent(db, g, "grant_revoked", c.actor);
          return publicGuest(g, !c.audience);
        });
      });
    });
  app.post("/streams/:streamId/guests/:guestId/join-grant", async (request, reply) => {
    const input = validate(guestDecisionSchema, request.body);
    const result = await database.transaction(async (db) => {
      const c = await scoped(db, request, true);
      running(c);
      if (!c.stage || !c.path.guestId) throw missing();
      if (!c.audience) {
        await authorize(db, principal(request), c.stream, "tokens:create");
        await authorize(db, principal(request), c.stream, "streams:publish");
      }
      const a = await own(db, c, input.subject),
        g = await getGuest(db, c.path.guestId, c.run.id, true);
      if (g.subject !== a.subject) throw missing();
      if (
        g.version !== input.version ||
        !["accepted", "approved", "joined"].includes(g.state) ||
        g.expires_at.getTime() <= Date.now()
      )
        throw conflict("GUEST_GRANT_REVOKED", "This guest reservation is no longer valid.");
      const [participant] = g.participant_id
        ? await db.execute(
            sql`SELECT left_at,removed_at FROM participant WHERE id=${g.participant_id}`,
          )
        : [];
      if (participant?.left_at && g.state === "joined")
        throw conflict(
          "GUEST_REJOIN_REQUIRED",
          "Request a new stage invitation after the reconnect period.",
        );
      const [issuance] = await db.execute(
        sql`SELECT count(*) FILTER(WHERE expires_at>now()+interval '4 minutes')::int AS n,max(expires_at) AS last FROM stream_guest_grant WHERE guest_id=${g.id} AND version=${g.version}`,
      );
      if (Number(issuance?.n) >= 10)
        throw new ApiError(
          429,
          "GUEST_GRANT_LIMIT",
          "Too many stage credentials were requested. Retry shortly.",
        );
      const participantId =
          !g.participant_id || participant?.left_at ? id("guestp") : g.participant_id,
        tokenId = id("ptok"),
        issuedAt = new Date(),
        expiresAt = new Date(
          Math.max(
            Date.now() + 300000,
            issuance?.last ? z.coerce.date().parse(issuance.last).getTime() + 1000 : 0,
          ),
        );
      if (expiresAt.getTime() > Date.now() + 310000)
        throw new ApiError(
          429,
          "GUEST_GRANT_LIMIT",
          "Wait briefly before renewing stage credentials.",
        );
      await db.execute(
        sql`UPDATE stream_guest SET participant_id=${participantId},name=${a.name},expires_at=${expiresAt} WHERE id=${g.id}`,
      );
      await db.execute(
        sql`INSERT INTO stream_guest_grant(token_id,guest_id,participant_id,version,expires_at) VALUES(${tokenId},${g.id},${participantId},${g.version},${expiresAt})`,
      );
      const media = {
        audio: g.media.audio && !g.muted_audio,
        video: g.media.video && !g.muted_video,
        screen: g.media.screen && !g.muted_video,
      };
      const permissions = [
        "room:join" as const,
        ...(media.audio ? ["audio:publish" as const] : []),
        ...(media.video ? ["video:publish" as const] : []),
        ...(media.screen ? ["screen:publish" as const] : []),
      ];
      return {
        token: await signer.sign({
          roomId: c.stage.room_id,
          projectId: c.stream.projectId,
          environmentId: c.stream.environmentId,
          participantId,
          tokenId,
          participantName: a.name,
          permissions,
          metadata: { guestId: g.id, broadcastId: c.run.id },
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        }),
        participantId,
        roomId: c.stage.room_id,
        expiresAt: expiresAt.toISOString(),
        version: g.version,
        media,
        signalingUrl: config.guestSignalingUrl,
      };
    });
    return reply.code(201).send(result);
  });
  app.get("/guests/openapi", () => guestOpenApi());
  return Promise.resolve();
};
