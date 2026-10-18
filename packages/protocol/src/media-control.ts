import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

const identifier = z.string().min(1).max(128);
const service = z.enum(["relayrtc-api", "relayrtc-console", "relayrtc-signaling"]);
const authority = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("capacity") }).strict(),
  z.object({ kind: z.literal("room"), roomId: identifier }).strict(),
  z
    .object({
      kind: z.literal("participant"),
      subjectId: identifier.optional(),
      roomId: identifier,
      participantId: identifier,
      sessionId: identifier,
    })
    .strict(),
  z
    .object({
      kind: z.literal("participant-cleanup"),
      roomId: identifier,
      participantId: identifier,
    })
    .strict(),
]);

const headerSchema = z
  .object({
    alg: z.literal("HS256"),
    typ: z.literal("relayrtc-media-control+jwt"),
  })
  .strict();

const claimsSchema = z
  .object({
    aud: z.literal("relayrtc-media-control"),
    iss: service,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
    path: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^\/internal\/v1\//u),
    authority,
  })
  .strict()
  .refine(
    (claims) =>
      (claims.authority.kind !== "participant" &&
        claims.authority.kind !== "participant-cleanup") ||
      claims.iss === "relayrtc-signaling",
  );

export type MediaControlAuthority = z.infer<typeof authority>;
export type MediaControlClaims = z.infer<typeof claimsSchema>;
export type MediaControlService = z.infer<typeof service>;

export interface MediaControlTokenOptions {
  authority: MediaControlAuthority;
  method: MediaControlClaims["method"];
  path: string;
  service: MediaControlService;
}

const requireSecret = (secret: string): void => {
  if (secret.length < 32)
    throw new Error("Media control requires an internal secret of at least 32 characters");
};

export const createMediaControlToken = (
  secret: string,
  options: MediaControlTokenOptions,
  now = Math.floor(Date.now() / 1000),
): string => {
  requireSecret(secret);
  const claims = claimsSchema.parse({
    aud: "relayrtc-media-control",
    iss: options.service,
    iat: now,
    exp: now + 30,
    method: options.method,
    path: options.path,
    authority: options.authority,
  });
  const header = Buffer.from(
    JSON.stringify({
      alg: "HS256",
      typ: "relayrtc-media-control+jwt",
    }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const content = `${header}.${payload}`;
  return `${content}.${createHmac("sha256", secret).update(content).digest("base64url")}`;
};

export const verifyMediaControlToken = (
  secret: string,
  token: string,
  now = Math.floor(Date.now() / 1000),
): MediaControlClaims | null => {
  requireSecret(secret);
  if (token.length > 4096) return null;
  const parts = token.split(".");
  const [header, payload, signature] = parts;
  if (
    parts.length !== 3 ||
    !header ||
    !payload ||
    !signature ||
    !parts.every((part) => /^[A-Za-z0-9_-]+$/u.test(part))
  )
    return null;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    headerSchema.parse(JSON.parse(Buffer.from(header, "base64url").toString("utf8")));
    const claims = claimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    if (
      claims.iat > now + 5 ||
      claims.exp <= now ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 30
    )
      return null;
    return claims;
  } catch {
    return null;
  }
};
