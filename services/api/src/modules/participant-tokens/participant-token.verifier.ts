import { jwtVerify } from "jose";
import { metadataSchema, nameSchema } from "@relayrtc/validation";
import { z } from "zod";
import { ApiError } from "../../http/errors/api-error.js";
import { createParticipantTokenBodySchema } from "./participant-token.schema.js";
import type {
  ParticipantTokenClaims,
  ParticipantTokenSignerConfig,
} from "./participant-token.signer.js";

const id = z.string().min(1).max(128).regex(/^\S+$/u);
const claimsSchema = z.object({
  environmentId: id,
  projectId: id,
  roomId: id,
  participantId: id,
  tokenId: id,
  participantName: nameSchema,
  metadata: metadataSchema,
  permissions: createParticipantTokenBodySchema.shape.permissions.unwrap(),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: id,
  sub: id,
});

export interface ParticipantTokenVerifier {
  verify(token: string, now: Date): Promise<ParticipantTokenClaims>;
}

export function createParticipantTokenVerifier(
  config: ParticipantTokenSignerConfig,
): ParticipantTokenVerifier {
  const secret = new TextEncoder().encode(config.secret);
  return {
    async verify(token, now) {
      try {
        const { payload, protectedHeader } = await jwtVerify(token, secret, {
          algorithms: ["HS256"],
          audience: config.audience,
          issuer: config.issuer,
          currentDate: now,
          requiredClaims: ["exp", "iat", "jti", "sub"],
        });
        const claims = claimsSchema.parse(payload);
        if (
          protectedHeader.kid !== config.keyId ||
          protectedHeader.typ !== "JWT" ||
          claims.jti !== claims.tokenId ||
          claims.sub !== claims.participantId ||
          claims.iat > Math.floor(now.getTime() / 1000) ||
          Math.floor(Date.parse(claims.issuedAt) / 1000) !== claims.iat ||
          Math.floor(Date.parse(claims.expiresAt) / 1000) !== claims.exp ||
          claims.exp <= claims.iat ||
          claims.exp - claims.iat > 3600
        )
          throw new Error("Invalid claims");
        return claims;
      } catch {
        throw new ApiError(
          401,
          "INVALID_PARTICIPANT_TOKEN",
          "Provide a valid, unexpired participant token",
        );
      }
    },
  };
}
