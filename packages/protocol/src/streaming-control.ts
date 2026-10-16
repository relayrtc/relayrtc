import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const claimsSchema = z
  .object({
    aud: z.enum(["streaming-worker", "streaming-gateway", "streaming-playback", "streaming-media"]),
    sub: z.string().min(1).max(128),
    streamId: z.string().max(128),
    sessionId: z.string().max(128),
    action: z.string().max(80),
    generation: z.number().int().nonnegative(),
    exp: z.number().int(),
    iat: z.number().int(),
  })
  .strict();
export type StreamingClaims = z.infer<typeof claimsSchema>;
export function signStreamingGrant(
  secret: string,
  claims: Omit<StreamingClaims, "exp" | "iat">,
  ttlSeconds = 30,
): string {
  if (secret.length < 32 || ttlSeconds < 1 || ttlSeconds > 86400)
    throw new Error("Invalid streaming grant configuration");
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify(claimsSchema.parse({ ...claims, iat, exp: iat + ttlSeconds })),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export function verifyStreamingGrant(
  secret: string,
  token: string,
  audience: StreamingClaims["aud"],
): StreamingClaims | null {
  if (secret.length < 32 || token.length > 4096) return null;
  const [payload, signature, extra] = token.split(".");
  if (
    !payload ||
    !signature ||
    extra !== undefined ||
    !/^[\w-]+$/u.test(payload) ||
    !/^[\w-]+$/u.test(signature)
  )
    return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const claims = claimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    const now = Math.floor(Date.now() / 1000);
    return claims.aud === audience &&
      claims.iat <= now + 5 &&
      claims.exp > now &&
      claims.exp > claims.iat &&
      claims.exp - claims.iat <= 86400
      ? claims
      : null;
  } catch {
    return null;
  }
}
export const streamingSecretHash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
