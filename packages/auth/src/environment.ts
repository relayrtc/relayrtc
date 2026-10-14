import { enforceCredentialPolicy, readInternalSecret } from "@relayrtc/protocol/credential-policy";

export type AuthEnvironmentSource = Readonly<Record<string, string | undefined>>;

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface OAuthProviderCredentials {
  github: OAuthClientCredentials;
  google: OAuthClientCredentials;
}

export interface AuthEnvironment {
  baseUrl: string;
  databaseUrl: string;
  email: {
    apiKey: string;
    from: string;
  };
  oauthProviders: OAuthProviderCredentials;
  secret: string;
  skipEmailVerification?: boolean;
  trustedOrigins: string[];
}

const readRequired = (source: AuthEnvironmentSource, name: string): string => {
  const value = source[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
};

const parseHttpOrigin = (value: string, name: string): string => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }

  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`${name} must be an origin without credentials or a path`);
  }

  return url.origin;
};

export const readAuthEnvironment = (source: AuthEnvironmentSource): AuthEnvironment => {
  enforceCredentialPolicy(source, [
    "DATABASE_URL",
    "RELAYRTC_INTERNAL_SECRET",
    "RELAYRTC_MEDIA_INTERNAL_URL",
    "RELAYRTC_SIGNALING_INTERNAL_URL",
  ]);
  readInternalSecret(source);
  const secret = readRequired(source, "BETTER_AUTH_SECRET");

  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }

  const databaseUrl = readRequired(source, "DATABASE_URL");

  try {
    const url = new URL(databaseUrl);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new Error();
    }
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }

  const baseUrl = parseHttpOrigin(readRequired(source, "BETTER_AUTH_URL"), "BETTER_AUTH_URL");
  const skipEmailVerification = source.SKIP_EMAIL_VERIFICATION?.trim().toLowerCase() ?? "false";
  if (!["true", "false"].includes(skipEmailVerification)) throw new Error("SKIP_EMAIL_VERIFICATION must be true or false");
  const trustedOrigins = (source.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map((origin) => parseHttpOrigin(origin, "BETTER_AUTH_TRUSTED_ORIGINS"));

  return {
    baseUrl,
    databaseUrl,
    email: {
      apiKey: readRequired(source, "RESEND_API_KEY"),
      from: readRequired(source, "RESEND_FROM_EMAIL"),
    },
    oauthProviders: {
      github: {
        clientId: readRequired(source, "GITHUB_CLIENT_ID"),
        clientSecret: readRequired(source, "GITHUB_CLIENT_SECRET"),
      },
      google: {
        clientId: readRequired(source, "GOOGLE_CLIENT_ID"),
        clientSecret: readRequired(source, "GOOGLE_CLIENT_SECRET"),
      },
    },
    secret,
    skipEmailVerification: skipEmailVerification === "true",
    trustedOrigins: [...new Set([baseUrl, ...trustedOrigins])],
  };
};
