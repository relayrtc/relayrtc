import { describe, expect, it } from "vitest";

import { readAuthEnvironment } from "./environment.js";

const validEnvironment = {
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
  DATABASE_URL: "postgresql://relaykit:password@localhost:5432/relaykit",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  RESEND_API_KEY: "re_test_123",
  RESEND_FROM_EMAIL: "RelayRTC <noreply@relayrtc.com>",
};

describe("readAuthEnvironment", () => {
  it("parses and deduplicates explicitly trusted origins", () => {
    expect(
      readAuthEnvironment({
        ...validEnvironment,
        BETTER_AUTH_TRUSTED_ORIGINS: "https://dashboard.example.com,http://localhost:3000",
      }),
    ).toEqual({
      baseUrl: "http://localhost:3000",
      databaseUrl: validEnvironment.DATABASE_URL,
      email: {
        apiKey: validEnvironment.RESEND_API_KEY,
        from: validEnvironment.RESEND_FROM_EMAIL,
      },
      oauthProviders: {
        github: {
          clientId: validEnvironment.GITHUB_CLIENT_ID,
          clientSecret: validEnvironment.GITHUB_CLIENT_SECRET,
        },
        google: {
          clientId: validEnvironment.GOOGLE_CLIENT_ID,
          clientSecret: validEnvironment.GOOGLE_CLIENT_SECRET,
        },
      },
      secret: validEnvironment.BETTER_AUTH_SECRET,
      skipEmailVerification: false,
      trustedOrigins: ["http://localhost:3000", "https://dashboard.example.com"],
    });
  });

  it("requires an explicit opt-in to skip email verification", () => {
    expect(
      readAuthEnvironment({ ...validEnvironment, SKIP_EMAIL_VERIFICATION: "true" })
        .skipEmailVerification,
    ).toBe(true);
    expect(() =>
      readAuthEnvironment({ ...validEnvironment, SKIP_EMAIL_VERIFICATION: "yes" }),
    ).toThrow("SKIP_EMAIL_VERIFICATION");
  });

  it("rejects missing and weak secrets", () => {
    expect(() => readAuthEnvironment({ ...validEnvironment, BETTER_AUTH_SECRET: "short" })).toThrow(
      "at least 32 characters",
    );
  });

  it("rejects non-PostgreSQL database URLs", () => {
    expect(() =>
      readAuthEnvironment({
        ...validEnvironment,
        DATABASE_URL: "mysql://localhost/relaykit",
      }),
    ).toThrow("valid PostgreSQL URL");
  });

  it("rejects base URLs containing paths", () => {
    expect(() =>
      readAuthEnvironment({
        ...validEnvironment,
        BETTER_AUTH_URL: "https://relayrtc.example.com/dashboard",
      }),
    ).toThrow("must be an origin");
  });

  it.each(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])(
    "requires the %s OAuth credential",
    (name) => {
      expect(() =>
        readAuthEnvironment({
          ...validEnvironment,
          [name]: "",
        }),
      ).toThrow(`${name} is required`);
    },
  );

  it.each(["RESEND_API_KEY", "RESEND_FROM_EMAIL"])(
    "requires the %s email configuration",
    (name) => {
      expect(() =>
        readAuthEnvironment({
          ...validEnvironment,
          [name]: "",
        }),
      ).toThrow(`${name} is required`);
    },
  );
});

describe("production account credential policy", () => {
  const production = {
    ...validEnvironment,
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: "independent-account-authentication-key",
    DATABASE_URL: "postgresql://relaykit:independent-database-password@postgres/relaykit",
    RELAYRTC_INTERNAL_SECRET: "independent-internal-control-key-456",
    RELAYRTC_MEDIA_INTERNAL_URL: "http://media:8082/internal/v1",
    RELAYRTC_SIGNALING_INTERNAL_URL: "http://signaling:8081/internal/v1",
  };
  it("accepts separated credentials", () => {
    expect(readAuthEnvironment(production).secret).toBe(production.BETTER_AUTH_SECRET);
  });
  it("rejects omitted control credentials, placeholders, and account/control reuse", () => {
    expect(() =>
      readAuthEnvironment({ ...production, RELAYRTC_INTERNAL_SECRET: undefined }),
    ).toThrow("RELAYRTC_INTERNAL_SECRET");
    expect(() =>
      readAuthEnvironment({
        ...production,
        BETTER_AUTH_SECRET: validEnvironment.BETTER_AUTH_SECRET,
      }),
    ).toThrow("BETTER_AUTH_SECRET");
    expect(() =>
      readAuthEnvironment({
        ...production,
        BETTER_AUTH_SECRET: production.RELAYRTC_INTERNAL_SECRET,
      }),
    ).toThrow("separate credentials");
  });
});
