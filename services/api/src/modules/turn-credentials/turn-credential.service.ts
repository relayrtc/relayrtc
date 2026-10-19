import { createHmac, randomBytes, randomUUID } from "node:crypto";

import type { TurnCredentials } from "@relayrtc/types";

export interface TurnCredentialScope {
  readonly environmentId: string;
  readonly projectId: string;
  readonly roomId?: string;
  readonly sessionId?: string;
  readonly participantId?: string;
}

export interface TurnCredentialIssuer {
  issue(scope: TurnCredentialScope): TurnCredentials | Promise<TurnCredentials>;
}

interface TurnCredentialServiceOptions {
  readonly clock?: () => Date;
  readonly createId?: () => string;
  readonly secret: string;
  readonly managed?: boolean;
  readonly stunUrls: readonly string[];
  readonly ttlSeconds: number;
  readonly turnUrls: readonly string[];
}

export const createTurnCredentialService = (
  options: TurnCredentialServiceOptions,
): { issue(scope: TurnCredentialScope): TurnCredentials } => ({
  issue(scope) {
    if (
      !Number.isInteger(options.ttlSeconds) ||
      options.ttlSeconds < 60 ||
      options.ttlSeconds > 3600
    )
      throw new Error("TURN credential lifetime must be between 60 and 3600 seconds");
    if (Boolean(scope.roomId) !== Boolean(scope.sessionId))
      throw new Error("TURN room and session scope must be supplied together");
    const now = options.clock?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error("TURN credentials require a valid clock");
    const expiresAtSeconds = Math.floor(now.getTime() / 1_000) + options.ttlSeconds;
    const createId = options.createId ?? (() => randomUUID().replaceAll("-", ""));
    const username = [expiresAtSeconds, scope.projectId, scope.environmentId, createId()].join(":");
    if (!/^[A-Za-z0-9_.:-]{1,512}$/u.test(username))
      throw new Error("TURN identity contains unsupported characters");
    const credential = options.managed
      ? randomBytes(32).toString("base64")
      : createHmac("sha1", options.secret).update(username).digest("base64");

    return {
      expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
      iceServers: [
        { urls: [...options.stunUrls] },
        {
          credential,
          credentialType: "password",
          urls: [...options.turnUrls],
          username,
        },
      ],
      ttlSeconds: options.ttlSeconds,
      username,
    };
  },
});
