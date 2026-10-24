export const apiKeyErrorCodes = [
  "INVALID_API_KEY_INPUT",
  "API_KEY_NOT_FOUND",
  "API_KEY_ACCESS_DENIED",
  "API_KEY_MANAGEMENT_FORBIDDEN",
  "API_KEY_ENVIRONMENT_MISMATCH",
  "API_KEY_EXPIRATION_INVALID",
  "API_KEY_REVOKED",
  "API_KEY_CREATION_FAILED",
  "API_KEY_ROTATION_FAILED",
  "API_KEY_REVOCATION_FAILED",
] as const

export type ApiKeyErrorCode = (typeof apiKeyErrorCodes)[number]

export interface ApiKeyError {
  readonly code: ApiKeyErrorCode
  readonly description: string
}

const descriptions: Readonly<Record<ApiKeyErrorCode, string>> = {
  INVALID_API_KEY_INPUT: "Enter valid API key information",
  API_KEY_NOT_FOUND: "The API key could not be found",
  API_KEY_ACCESS_DENIED: "You do not have access to these API keys",
  API_KEY_MANAGEMENT_FORBIDDEN: "Only organization owners and admins can manage API keys",
  API_KEY_ENVIRONMENT_MISMATCH: "The environment does not belong to this project",
  API_KEY_EXPIRATION_INVALID: "API key expiration must be in the future",
  API_KEY_REVOKED: "The API key has already been revoked",
  API_KEY_CREATION_FAILED: "The API key could not be created",
  API_KEY_ROTATION_FAILED: "The API key could not be rotated",
  API_KEY_REVOCATION_FAILED: "The API key could not be revoked",
}

export const apiKeyError = (code: ApiKeyErrorCode): ApiKeyError => ({
  code,
  description: descriptions[code],
})

export type ApiKeyResult<T> =
  | { data: T; error: null }
  | { data: null; error: ApiKeyError }

