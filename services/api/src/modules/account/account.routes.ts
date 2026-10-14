import { createHash } from "node:crypto";
import {
  createRelayKitAuth, createRelayKitAuthHandler, createResendInvitationSender,
  createAccountEmailSender, createQueuedAccountEmailSender, deliverAccountEmails,
  recordAudit, setAuditContext, type AuthEnvironment, type AuditActor, type RelayKitAuth,
} from "@relayrtc/auth/server";
import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import type { FastifyPluginCallback, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import { auditQuery, listAuditEvents } from "./audit-service.js";

interface Options { database: RelayKitDatabase; environment: AuthEnvironment }
const password = z.string().min(8).max(128);
const profile = z.object({ name: z.string().trim().min(1).max(120),
  image: z.union([z.url().refine((url) => url.startsWith("https://"), "Use an HTTPS image URL"), z.null()]).optional(),
}).strict();
const sensitivePaths = new Set(["/change-password", "/link-social", "/unlink-account",
  "/email-otp/request-email-change", "/email-otp/change-email", "/revoke-session", "/revoke-sessions", "/revoke-other-sessions",
  "/two-factor/enable", "/two-factor/disable", "/two-factor/generate-backup-codes", "/two-factor/get-totp-uri"]);
const sendingPaths = new Set(["/request-password-reset", "/email-otp/request-password-reset", "/forget-password/email-otp",
  "/email-otp/send-verification-otp", "/email-otp/request-email-change", "/send-verification-email"]);

const headersFor = (request: FastifyRequest) => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined && !["content-length", "host", "x-forwarded-for", "x-real-ip", "x-forwarded-host", "x-forwarded-proto"].includes(key)) {
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  // Better Auth receives the IP already resolved by Fastify's trusted proxy policy.
  headers.set("x-forwarded-for", request.ip);
  headers.set("x-request-id", request.id);
  return headers;
};
async function sendResponse(reply: FastifyReply, response: Response) {
  response.headers.forEach((value, key) => { if (key !== "set-cookie") reply.header(key, value); });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) reply.header("set-cookie", cookies);
  return reply.code(response.status).send(await response.text());
}

export const accountRoutes: FastifyPluginCallback<Options> = (app, options, done) => {
  app.addHook("onRoute", (route) => { route.bodyLimit = 16384; });
  const environment = options.environment;
  const authOptions = {
    database: options.database, baseUrl: environment.baseUrl, secret: environment.secret,
    oauthProviders: environment.oauthProviders, trustedOrigins: environment.trustedOrigins,
    skipEmailVerification: environment.skipEmailVerification ?? false,
    sendInvitationEmail: createResendInvitationSender({ ...environment.email, baseUrl: environment.baseUrl }),
  };
  const auth = createRelayKitAuth(authOptions);
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof ApiError;
    const status = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    const inputError = !known && status >= 400 && status < 500;
    // Driver errors may contain SQL parameters, including password hashes.
    if (!known && !inputError) app.log.error({ requestId: request.id }, "Account API request failed");
    return reply.code(status).send({
      code: known ? error.code : inputError ? "INVALID_REQUEST" : "ACCOUNT_SERVICE_UNAVAILABLE",
      description: known ? error.description : inputError ? "The account request is invalid or too large." : "Account services are temporarily unavailable. Please try again.", requestId: request.id,
    });
  });
  const current = async (request: FastifyRequest) => {
    const session = await auth.api.getSession({ headers: headersFor(request), query: { disableCookieCache: true, disableRefresh: true } });
    if (!session) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Sign in to manage your account.");
    return session;
  };
  const actorFor = async (request: FastifyRequest): Promise<AuditActor> => {
    const session = await auth.api.getSession({ headers: headersFor(request), query: { disableCookieCache: true, disableRefresh: true } });
    return session ? { type: "USER", id: session.user.id, name: session.user.name } : { type: "ANONYMOUS", name: "Unauthenticated request" };
  };
  const mutate = async (request: FastifyRequest, callback: (database: RelayKitDatabase, scopedAuth: RelayKitAuth) => Promise<unknown>) => {
    const session = await current(request);
    return options.database.transaction(async (transaction) => {
      await setAuditContext(transaction, { type: "USER", id: session.user.id, name: session.user.name }, request.id);
      await transaction.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, session.user.id)).for("update");
      const database = transaction as unknown as RelayKitDatabase;
      return callback(database, createRelayKitAuth({ ...authOptions, database }));
    });
  };

  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    reply.header("referrer-policy", "no-referrer");
    // Browser traffic goes through the same-origin console proxy. Reject any
    // supplied foreign Origin rather than enabling credentialed wildcard CORS.
    const origin = request.headers.origin;
    if (origin && !environment.trustedOrigins.includes(origin)) throw new ApiError(403, "ORIGIN_DENIED", "The request origin is not trusted.");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && (!origin || request.headers["sec-fetch-site"] === "cross-site")) {
      throw new ApiError(403, "ORIGIN_REQUIRED", "Account changes require a trusted Origin header.");
    }
  });
  app.addHook("preHandler", async (request, reply) => {
    const path = (request.url.split("?")[0] ?? "").replace(/^\/api\/auth/, "");
    const windowSeconds = 60;
    const max = sendingPaths.has(path) ? 3 : 60;
    const keys = [`ip:${request.ip}`];
    if (sensitivePaths.has(path)) {
      const session = await current(request);
      keys.push(`user:${session.user.id}`);
    }
    const body = request.body as { email?: unknown; newEmail?: unknown } | undefined;
    if (sendingPaths.has(path)) {
      const email = typeof body?.email === "string" ? body.email : body?.newEmail;
      if (typeof email === "string") keys.push(`email:${email.trim().toLowerCase()}`);
    }
    for (const key of keys) {
      const limitPath = sendingPaths.has(path) ? path : request.routeOptions.url ?? "unknown";
      const digest = createHash("sha256").update(`${request.method}:${limitPath}:${key}`).digest("hex");
      const rows = await options.database.execute<{ count: number; retry: number }>(sql`
        INSERT INTO account_request_limit(key, count, expires_at) VALUES (${digest}, 1, now() + ${windowSeconds} * interval '1 second')
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN account_request_limit.expires_at <= now() THEN 1 ELSE account_request_limit.count + 1 END,
          expires_at = CASE WHEN account_request_limit.expires_at <= now() THEN now() + ${windowSeconds} * interval '1 second' ELSE account_request_limit.expires_at END
        RETURNING count, greatest(1, ceil(extract(epoch FROM expires_at - now())))::integer AS retry`);
      if ((rows[0]?.count ?? max + 1) > max) {
        reply.header("retry-after", rows[0]?.retry ?? windowSeconds);
        throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please wait before trying again.");
      }
    }
  });
  app.addHook("onError", async (request, _reply, error) => {
    if (request.method === "GET") return;
    const actor = await actorFor(request);
    await recordAudit(options.database, { actor, action: "account.request_failed",
      resourceType: "user", subjectUserId: actor.id, outcome: "FAILURE", correlationId: request.id,
      metadata: { status: error.statusCode ?? 500, method: request.method } });
  });

  app.route({ method: ["GET", "POST"], url: "/api/auth/*", handler: async (request, reply) => {
    const path = (request.url.split("?")[0] ?? "").replace(/^\/api\/auth/, "");
    // Use the ownership-aware confirmation endpoint and the two-address OTP flow.
    if (["/delete-user", "/delete-user/callback", "/change-email", "/sign-in/email-otp"].includes(path)) {
      throw new ApiError(403, "USE_ACCOUNT_WORKFLOW", "Use the account settings workflow for this operation.");
    }
    if (path === "/email-otp/send-verification-otp") {
      const body = validate(z.object({ email: z.email(), type: z.literal("email-verification") }).strict(), request.body);
      const session = await auth.api.getSession({ headers: headersFor(request) });
      if (session && session.user.email.toLowerCase() !== body.email.toLowerCase()) throw new ApiError(403, "EMAIL_MISMATCH", "Verify your current account email.");
    }
    if (path === "/update-user") validate(profile, request.body);
    if (path === "/change-password") validate(z.object({ currentPassword: z.string().min(1).max(128), newPassword: password, revokeOtherSessions: z.literal(true) }).strict(), request.body);
    if (path === "/unlink-account") {
      const session = await current(request);
      const accounts = await options.database.select({ providerId: schema.account.providerId, password: schema.account.password }).from(schema.account).where(eq(schema.account.userId, session.user.id));
      if (accounts.filter((account) => account.providerId !== "credential" || account.password).length < 2) {
        throw new ApiError(409, "LAST_LOGIN_METHOD", "Keep at least one usable login method connected.");
      }
    }
    const actor = await actorFor(request);
    const email = (request.body as { email?: unknown } | undefined)?.email;
    const [subject] = typeof email === "string" && z.email().safeParse(email).success
      ? await options.database.select({ id: schema.user.id }).from(schema.user).where(sql`lower(${schema.user.email}) = ${email.toLowerCase()}`) : [];
    const response = await options.database.transaction(async (transaction) => {
      await setAuditContext(transaction, actor, request.id);
      if (actor.type === "USER" && actor.id && sensitivePaths.has(path)) {
        await transaction.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, actor.id)).for("update");
      }
      const database = transaction as unknown as RelayKitDatabase;
      const scopedAuth = createRelayKitAuth({ ...authOptions, database });
      const headers = headersFor(request);
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const response = await createRelayKitAuthHandler(scopedAuth)(new Request(new URL(request.url, environment.baseUrl), {
        method: request.method, headers, ...(hasBody && request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      }));
      if (request.method === "POST" || path.startsWith("/callback/")) {
        const location = response.headers.get("location");
        const destination = location ? new URL(location, environment.baseUrl) : null;
        const payload = response.headers.get("content-type")?.includes("application/json")
          ? await response.clone().json().catch(() => null) as { twoFactorRedirect?: boolean; user?: { id?: string; name?: string } } | null : null;
        const failed = response.status >= 400 || destination?.searchParams.has("error");
        const pendingMfa = payload?.twoFactorRedirect === true || destination?.pathname === "/auth/two-factor";
        const identityProved = ["/sign-in/email", "/sign-in/social", "/two-factor/verify-totp", "/two-factor/verify-backup-code", "/email-otp/verify-email"].includes(path);
        const authenticated = identityProved && !failed && !pendingMfa && actor.type === "ANONYMOUS" && payload?.user?.id && payload.user.name
          ? { type: "USER" as const, id: payload.user.id, name: payload.user.name } : actor;
        await recordAudit(transaction, { actor: authenticated, subjectUserId: authenticated.type === "USER" ? authenticated.id : subject?.id,
          resourceType: "user", resourceId: authenticated.id, correlationId: request.id,
          action: `auth.${path.slice(1).replaceAll("/", ".")}`, outcome: failed ? "FAILURE" : pendingMfa ? "ATTEMPT" : "SUCCESS",
          metadata: { status: response.status } });
      }
      if (response.ok && actor.type === "USER" && ["/change-password", "/email-otp/change-email", "/unlink-account", "/two-factor/disable", "/two-factor/generate-backup-codes"].includes(path)) {
        const session = await current(request);
        await createQueuedAccountEmailSender(transaction, environment.secret)({ to: session.user.email,
          subject: "RelayRTC account security change", text: "A security setting on your RelayRTC account was changed. Review your account audit log. If this was not you, recover your account immediately." });
        if (path === "/email-otp/change-email") {
          const [updated] = await transaction.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, session.user.id));
          if (updated && updated.email !== session.user.email) await createQueuedAccountEmailSender(transaction, environment.secret)({ to: updated.email,
            subject: "RelayRTC email address changed", text: "Your new email address is now verified and active on your RelayRTC account." });
        }
        if (path === "/email-otp/change-email" || path === "/two-factor/disable") {
          await transaction.delete(schema.session).where(and(eq(schema.session.userId, session.user.id), ne(schema.session.id, session.session.id)));
        }
      }
      return response;
    });
    return sendResponse(reply, response);
  } });

  app.get("/api/account/verification-policy", () => Promise.resolve({ emailVerificationRequired: !environment.skipEmailVerification }));
  app.get("/api/account", async (request) => {
    const session = await current(request);
    const accounts = await options.database.select({ id: schema.account.id, providerId: schema.account.providerId,
      accountId: schema.account.accountId, createdAt: schema.account.createdAt }).from(schema.account).where(eq(schema.account.userId, session.user.id));
    const owned = await options.database.select({ id: schema.organization.id, name: schema.organization.name, role: schema.member.role })
      .from(schema.member).innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId)).where(eq(schema.member.userId, session.user.id));
    return { user: { id: session.user.id, name: session.user.name, email: session.user.email, image: session.user.image,
      emailVerified: session.user.emailVerified, twoFactorEnabled: session.user.twoFactorEnabled },
      accounts, emailVerificationRequired: !environment.skipEmailVerification,
      ownedOrganizations: owned.filter((item) => item.role.split(",").some((role) => role.trim() === "owner")) };
  });
  app.get("/api/account/sessions", async (request) => {
    const session = await current(request);
    const sessions = await options.database.select({ id: schema.session.id, userAgent: schema.session.userAgent,
      createdAt: schema.session.createdAt, updatedAt: schema.session.updatedAt, expiresAt: schema.session.expiresAt,
      ipAddress: schema.session.ipAddress }).from(schema.session).where(and(eq(schema.session.userId, session.user.id), gt(schema.session.expiresAt, new Date())));
    return { sessions: sessions.map((item) => ({ ...item, current: item.id === session.session.id })) };
  });
  app.post("/api/account/sessions/revoke", async (request) => {
    const { id } = validate(z.object({ id: z.string().min(1).max(128) }).strict(), request.body);
    const session = await current(request);
    return mutate(request, async (database) => {
      const revoked = await database.delete(schema.session).where(and(eq(schema.session.id, id), eq(schema.session.userId, session.user.id), ne(schema.session.id, session.session.id))).returning({ id: schema.session.id });
      if (!revoked.length) throw new ApiError(404, "SESSION_NOT_FOUND", "The other-device session was not found.");
      return { success: true };
    });
  });
  app.post("/api/account/password", async (request, reply) => {
    const body = validate(z.object({ newPassword: password }).strict(), request.body);
    const session = await current(request);
    return sendResponse(reply, await mutate(request, async (database, scopedAuth) => {
      const response = await scopedAuth.api.setPassword({ body, headers: headersFor(request), asResponse: true });
      if (response.ok) {
        await createQueuedAccountEmailSender(database, environment.secret)({ to: session.user.email, subject: "RelayRTC password added", text: "A password login method was added to your account. Review your security settings if this was not you." });
      }
      return response;
    }) as Response);
  });
  app.post("/api/account/delete", async (request, reply) => {
    const body = validate(z.object({ confirmationEmail: z.email(), password: z.string().max(128).optional() }).strict(), request.body);
    const session = await current(request);
    if (body.confirmationEmail.toLowerCase() !== session.user.email.toLowerCase()) throw new ApiError(400, "CONFIRMATION_MISMATCH", "Enter your current account email to confirm deletion.");
    const response = await mutate(request, async (database, scopedAuth) => {
      // Preflight UX plus database trigger protect against ownership races.
      const memberships = await database.select({ role: schema.member.role }).from(schema.member).where(eq(schema.member.userId, session.user.id));
      if (memberships.some((item) => item.role.split(",").some((role) => role.trim() === "owner"))) throw new ApiError(409, "ACCOUNT_OWNS_ORGANIZATION", "Transfer ownership or delete your organizations first.");
      await database.execute(sql`SELECT set_config('relayrtc.account_deletion', 'on', true)`);
      return scopedAuth.api.deleteUser({ body: body.password ? { password: body.password } : {}, headers: headersFor(request), asResponse: true });
    }) as Response;
    return sendResponse(reply, response);
  });
  app.get("/api/account/audit", async (request) => {
    const session = await current(request);
    return listAuditEvents(options.database, { userId: session.user.id }, validate(auditQuery, request.query));
  });
  app.get("/api/account/organizations/:organizationId/audit", async (request) => {
    const session = await current(request);
    const { organizationId } = validate(z.object({ organizationId: z.string().min(1).max(128) }), request.params);
    return listAuditEvents(options.database, { userId: session.user.id, organizationId }, validate(auditQuery, request.query));
  });
  app.get("/api/account/audit/export", async (request, reply) => {
    const session = await current(request);
    const query = validate(auditQuery, request.query);
    const result = await listAuditEvents(options.database, { userId: session.user.id }, { ...query, limit: 100 });
    await recordAudit(options.database, { actor: { type: "USER", id: session.user.id, name: session.user.name }, subjectUserId: session.user.id,
      action: "account.audit_exported", outcome: "SUCCESS", resourceType: "user", resourceId: session.user.id, correlationId: request.id });
    reply.header("content-disposition", 'attachment; filename="relayrtc-account-audit.json"');
    return result;
  });
  app.get("/api/account/organizations/:organizationId/audit/export", async (request, reply) => {
    const session = await current(request);
    const { organizationId } = validate(z.object({ organizationId: z.string().min(1).max(128) }), request.params);
    reply.header("content-disposition", 'attachment; filename="relayrtc-organization-audit.json"');
    const result = await listAuditEvents(options.database, { userId: session.user.id, organizationId }, { ...validate(auditQuery, request.query), limit: 100 });
    await recordAudit(options.database, { actor: { type: "USER", id: session.user.id, name: session.user.name }, organizationId,
      action: "organization.audit_exported", outcome: "SUCCESS", resourceType: "organization", resourceId: organizationId, correlationId: request.id });
    return result;
  });

  let stopped = false;
  let running: Promise<void> | undefined;
  let lastRetention = 0;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      await deliverAccountEmails(options.database, environment.secret, createAccountEmailSender(environment.email));
      if (Date.now() - lastRetention > 3600000) {
        await options.database.execute(sql`SELECT expire_account_security_history()`);
        lastRetention = Date.now();
      }
    })().catch(() => { app.log.error("Account email delivery or retention maintenance failed"); }).finally(() => { running = undefined; });
  };
  const timer = setInterval(tick, 2000);
  timer.unref();
  app.addHook("onReady", (ready) => { tick(); ready(); });
  app.addHook("onClose", async () => { stopped = true; clearInterval(timer); await running; });
  done();
};
