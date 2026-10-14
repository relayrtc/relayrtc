import { createDatabase, schema, type RelayKitDatabase } from "@relayrtc/database";
import type { BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { organization } from "better-auth/plugins/organization";
import { emailOTP } from "better-auth/plugins/email-otp";
import { twoFactor } from "better-auth/plugins/two-factor";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { eq, inArray, or, sql } from "drizzle-orm";
import { createQueuedAccountEmailSender } from "./account-delivery.js";
import type { AccountEmailSender } from "./account-email.js";
import { recordAudit } from "./audit.js";

import {
  readAuthEnvironment,
  type AuthEnvironmentSource,
  type OAuthProviderCredentials,
} from "./environment.js";
import { toAuthError } from "./errors.js";
import {
  createResendInvitationSender,
  type OrganizationInvitationSender,
} from "./invitation-email.js";
import { organizationRoles } from "./organization.js";
import { organizationOwnershipHooks } from "./ownership.js";
import { generateResourceSlug } from "./resource-slug.js";
import { relayKitSessionPolicy, sessionCookieAttributes } from "./session.js";

export interface RelayKitAuthOptions {
  baseUrl: string;
  database: RelayKitDatabase;
  oauthProviders: OAuthProviderCredentials;
  secret: string;
  sendInvitationEmail?: OrganizationInvitationSender;
  sendAccountEmail?: AccountEmailSender;
  trustedOrigins?: string[];
  skipEmailVerification?: boolean;
}

export interface RelayKitAuthEnvironmentResult {
  auth: RelayKitAuth;
  close: () => Promise<void>;
  database: RelayKitDatabase;
  handler: (request: Request) => Promise<Response>;
}

export const createRelayKitAuth = (options: RelayKitAuthOptions) => {
  const sendAccountEmail = options.sendAccountEmail ?? createQueuedAccountEmailSender(options.database, options.secret);
  const mfa = twoFactor({ issuer: "RelayRTC", allowPasswordless: true, skipVerificationOnEnable: false,
    backupCodeOptions: { amount: 10, length: 12, storeBackupCodes: "encrypted" },
    accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
  });
  // The upstream default challenges password sign-in only. Apply the same
  // challenge to OAuth and email-verification sessions; linking creates none.
  const signInHook = mfa.hooks.after[0];
  if (!signInHook) throw new Error("The MFA sign-in hook is unavailable");
  const originalMatcher = signInHook.matcher.bind(signInHook);
  signInHook.matcher = (context) => originalMatcher(context) ||
    context.path?.startsWith("/callback/") === true || context.path === "/sign-in/social" ||
    context.path === "/email-otp/verify-email" || context.path === "/verify-email";
  const configuration = {
    account: {
      accountLinking: {
        disableImplicitLinking: true,
        enabled: true,
        allowUnlinkingAll: false,
      },
      encryptOAuthTokens: true,
    },
    appName: "RelayRTC",
    // Fastify emits redacted operational errors and durable audit outcomes.
    logger: { disabled: true },
    advanced: {
      defaultCookieAttributes: sessionCookieAttributes(options.baseUrl),
    },
    baseURL: options.baseUrl,
    database: drizzleAdapter(options.database, {
      provider: "pg",
      schema,
    }),
    emailAndPassword: {
      autoSignIn: options.skipEmailVerification === true,
      enabled: true,
      requireEmailVerification: options.skipEmailVerification !== true,
      maxPasswordLength: 128,
      minPasswordLength: 8,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 1800,
      sendResetPassword: async ({ user, url }) => {
        await sendAccountEmail({ to: user.email, expiresInSeconds: 1800, subject: "Reset your RelayRTC password", text: `Reset your password: ${url}\nThis link expires in 30 minutes. If you did not request this, ignore this email.` });
      },
      onPasswordReset: async ({ user }, request) => {
        await recordAudit(options.database, { actor: { type: "USER", id: user.id, name: user.name }, subjectUserId: user.id,
          action: "account.password_reset", outcome: "SUCCESS", resourceType: "user", resourceId: user.id,
          correlationId: request?.headers.get("x-request-id") });
        await sendAccountEmail({ to: user.email, subject: "Your RelayRTC password was reset", text: "Your password was reset. Existing sessions have been revoked. If you did not do this, recover your account immediately." });
      },
    },
    emailVerification: {
      sendOnSignUp: options.skipEmailVerification !== true,
      sendOnSignIn: options.skipEmailVerification !== true,
      autoSignInAfterVerification: true,
      // The email-otp plugin supplies the sender; never send a second link email.
    },
    user: {
      changeEmail: { enabled: true, updateEmailWithoutVerification: false },
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          const memberships = await options.database.select({ role: schema.member.role }).from(schema.member).where(eq(schema.member.userId, user.id));
          if (memberships.some((membership) => membership.role.split(",").some((role) => role.trim() === "owner"))) {
            throw APIError.from("FORBIDDEN", { code: "ACCOUNT_OWNS_ORGANIZATION", message: "Transfer ownership or delete your organizations before deleting your account." });
          }
          await options.database.delete(schema.verification).where(or(eq(schema.verification.value, user.id),
            inArray(schema.verification.identifier, ["email-verification", "forget-password", "sign-in"].map((type) => `${type}-otp-${user.email.toLowerCase()}`)),
            sql`left(${schema.verification.identifier}, length(${`change-email-otp-${user.email.toLowerCase()}-`})) = ${`change-email-otp-${user.email.toLowerCase()}-`}`));
          await sendAccountEmail({ to: user.email, subjectUserId: user.id, subject: "Your RelayRTC account was deleted", text: "Your account and login credentials have been deleted. Retained organization accounting and audit history follow our retention policy." });
        },
      },
    },
    rateLimit: { enabled: true, window: 60, max: 60, storage: "memory" },
    plugins: [
      emailOTP({
        otpLength: 6, expiresIn: 300, allowedAttempts: 5, storeOTP: "hashed", disableSignUp: true,
        overrideDefaultEmailVerification: true,
        changeEmail: { enabled: true, verifyCurrentEmail: true },
        sendVerificationOTP: async ({ email, otp }) => {
          await sendAccountEmail({ to: email, expiresInSeconds: 300, subject: "Your RelayRTC verification code", text: `Your verification code is ${otp}. It expires in 5 minutes. Never share this code.` });
        },
      }),
      mfa,
      {
        id: "relayrtc-oauth-mfa-redirect",
        hooks: { after: [{ matcher: (context) => context.path?.startsWith("/callback/") === true,
          handler: createAuthMiddleware((context) => {
            const returned = context.context.returned as { twoFactorRedirect?: boolean } | undefined;
            if (returned?.twoFactorRedirect) {
              const challenge = new URL("/auth/two-factor", options.baseUrl);
              const destination = new URL(context.context.responseHeaders?.get("location") ?? "/auth/continue", options.baseUrl);
              if (destination.origin === new URL(options.baseUrl).origin) {
                challenge.searchParams.set("redirect", `${destination.pathname}${destination.search}${destination.hash}`);
              }
              throw context.redirect(challenge.toString());
            }
            return Promise.resolve();
          }),
        }] },
      },
      organization({
        creatorRole: "owner",
        disableOrganizationDeletion: true,
        organizationHooks: organizationOwnershipHooks,
        roles: organizationRoles,
        ...(options.sendInvitationEmail
          ? { sendInvitationEmail: options.sendInvitationEmail }
          : {}),
        schema: {
          member: {
            additionalFields: {
              updatedAt: {
                defaultValue: () => new Date(),
                input: false,
                required: true,
                type: "date",
              },
            },
          },
          organization: {
            additionalFields: {
              updatedAt: {
                defaultValue: () => new Date(),
                input: false,
                required: true,
                type: "date",
              },
            },
          },
        },
      }),
    ],
    session: relayKitSessionPolicy,
    socialProviders: {
      github: {
        clientId: options.oauthProviders.github.clientId,
        clientSecret: options.oauthProviders.github.clientSecret,
      },
      google: {
        clientId: options.oauthProviders.google.clientId,
        clientSecret: options.oauthProviders.google.clientSecret,
        prompt: "select_account",
      },
    },
    secret: options.secret,
    trustedOrigins: options.trustedOrigins ?? [options.baseUrl],
  } satisfies BetterAuthOptions;

  return betterAuth(configuration);
};

export type RelayKitAuth = ReturnType<typeof createRelayKitAuth>;
export { readAuthEnvironment } from "./environment.js";
export { createResendInvitationSender } from "./invitation-email.js";
export { createAccountEmailSender } from "./account-email.js";
export { createQueuedAccountEmailSender, deliverAccountEmails } from "./account-delivery.js";
export { recordAudit, setAuditContext, setUserAuditContext } from "./audit.js";
export type { AuditActor } from "./audit.js";
export type { AuthEnvironment } from "./environment.js";

export const createRelayKitSessionVerifier = (
  options: Pick<RelayKitAuthOptions, "baseUrl" | "database" | "secret">,
) => {
  const auth = betterAuth({
    baseURL: options.baseUrl,
    secret: options.secret,
    advanced: { defaultCookieAttributes: sessionCookieAttributes(options.baseUrl) },
    database: drizzleAdapter(options.database, { provider: "pg", schema }),
    session: relayKitSessionPolicy,
  });
  return async (headers: Headers): Promise<{ userId: string } | null> => {
    const session = await auth.api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    return session ? { userId: session.user.id } : null;
  };
};

export const createRelayKitAuthHandler =
  (auth: RelayKitAuth) =>
  async (request: Request): Promise<Response> => {
    let authRequest = request;
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/organization/create")) {
      const body: unknown = await request.clone().json().catch(() => null);
      if (typeof body === "object" && body !== null && "name" in body && typeof body.name === "string") {
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        authRequest = new Request(request, {
          body: JSON.stringify({ ...body, slug: generateResourceSlug(body.name, "organization") }),
          headers,
        });
      }
    }
    const response = await auth.handler(authRequest);

    if (response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      return response;
    }

    let payload: unknown;

    try {
      payload = await response.clone().json();
    } catch {
      payload = undefined;
    }

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");

    return new Response(JSON.stringify(toAuthError(payload, response.status)), {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };

export const createRelayKitAuthFromEnvironment = (
  source: AuthEnvironmentSource,
): RelayKitAuthEnvironmentResult => {
  const environment = readAuthEnvironment(source);
  const database = createDatabase(environment.databaseUrl);
  const auth = createRelayKitAuth({
    baseUrl: environment.baseUrl,
    database: database.db,
    oauthProviders: environment.oauthProviders,
    secret: environment.secret,
    skipEmailVerification: environment.skipEmailVerification ?? false,
    sendInvitationEmail: createResendInvitationSender({
      apiKey: environment.email.apiKey,
      baseUrl: environment.baseUrl,
      from: environment.email.from,
    }),
    trustedOrigins: environment.trustedOrigins,
  });

  return {
    auth,
    close: database.close,
    database: database.db,
    handler: createRelayKitAuthHandler(auth),
  };
};
