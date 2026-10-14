export const sessionExpiresInSeconds = 60 * 60 * 24 * 7;
export const sessionUpdateAgeSeconds = 60 * 60 * 24;
// Better Auth uses zero to disable recent-login requirements for valid sessions.
export const sessionFreshAgeSeconds = 0;

export const relayKitSessionPolicy = {
  cookieCache: {
    enabled: false,
  },
  deferSessionRefresh: true,
  expiresIn: sessionExpiresInSeconds,
  freshAge: sessionFreshAgeSeconds,
  storeSessionInDatabase: true,
  updateAge: sessionUpdateAgeSeconds,
} as const;

export const sessionCookieAttributes = (baseUrl: string) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: new URL(baseUrl).protocol === "https:",
});
