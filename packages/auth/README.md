# @relayrtc/auth

Shared Better Auth configuration for RelayRTC console accounts

## Required environment

```text
DATABASE_URL=postgresql://relaykit:password@localhost:5432/relaykit
BETTER_AUTH_SECRET=a-random-secret-containing-at-least-32-characters
BETTER_AUTH_URL=http://localhost:3002
```

The service also requires its internal credentials and addresses through the shared credential policy. The Docker setup generates these values automatically. Keep original secrets with deployment backups.

Email/password signup works without OAuth or email-provider credentials on local and public deployments. Without an email sender, verification is skipped and email-dependent recovery, email changes and invitations are unavailable. The wizard explicitly enables verification when email is configured and disables it when email is skipped.

## Optional providers

Configure a complete pair for each enabled OAuth provider:

```text
GITHUB_CLIENT_ID=github-client-id
GITHUB_CLIENT_SECRET=github-client-secret
GOOGLE_CLIENT_ID=google-client-id
GOOGLE_CLIENT_SECRET=google-client-secret
```

Set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` together to enable delivery. With a sender and no explicit `SKIP_EMAIL_VERIFICATION` setting, verification is required. An explicit `true` retains the existing verification override; `false` requires a sender. Partial provider configuration is rejected.

`BETTER_AUTH_TRUSTED_ORIGINS` is optional and accepts a comma-separated list of additional origins. Secrets must be generated independently for each deployment and must not be committed. The console receives only provider availability through the account verification-policy endpoint, never provider credentials.

## GitHub and Google OAuth

Register these exact local callback URLs in the provider consoles:

```text
http://localhost:3002/api/auth/callback/github
http://localhost:3002/api/auth/callback/google
```
