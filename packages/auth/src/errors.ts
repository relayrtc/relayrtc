export const authErrorCodes = [
  "INVALID_REQUEST",
  "INVALID_NAME",
  "INVALID_EMAIL",
  "INVALID_PASSWORD",
  "INVALID_CREDENTIALS",
  "EMAIL_NOT_VERIFIED",
  "INVALID_OTP",
  "OTP_EXPIRED",
  "MFA_FAILED",
  "ACCOUNT_OWNS_ORGANIZATION",
  "USER_EXISTS",
  "RATE_LIMITED",
  "OAUTH_ACCESS_DENIED",
  "OAUTH_ACCOUNT_CONFLICT",
  "OAUTH_EMAIL_UNAVAILABLE",
  "OAUTH_PROVIDER_UNAVAILABLE",
  "OAUTH_FAILED",
  "SESSION_REQUIRED",
  "SESSION_EXPIRED",
  "SESSION_NOT_FRESH",
  "SESSION_FAILED",
  "AUTHENTICATION_FAILED",
  "INVALID_ORGANIZATION_NAME",
  "INVALID_ORGANIZATION_SLUG",
  "ORGANIZATION_SLUG_TAKEN",
  "ORGANIZATION_SLUG_IMMUTABLE",
  "ORGANIZATION_CREATION_FORBIDDEN",
  "ORGANIZATION_LIMIT_REACHED",
  "ORGANIZATION_CREATION_FAILED",
  "ORGANIZATION_NOT_FOUND",
  "ORGANIZATION_ACCESS_DENIED",
  "ORGANIZATION_SWITCH_FAILED",
  "ORGANIZATION_UPDATE_FORBIDDEN",
  "ORGANIZATION_UPDATE_FAILED",
  "ORGANIZATION_DELETION_FORBIDDEN",
  "ORGANIZATION_CONFIRMATION_MISMATCH",
  "ORGANIZATION_DELETION_FAILED",
  "INVALID_INVITATION_EMAIL",
  "INVALID_INVITATION_ROLE",
  "INVITATION_ALREADY_SENT",
  "ORGANIZATION_MEMBER_EXISTS",
  "INVITATION_FORBIDDEN",
  "INVITATION_NOT_FOUND",
  "INVITATION_RECIPIENT_MISMATCH",
  "INVITATION_EMAIL_VERIFICATION_REQUIRED",
  "INVITATION_LIMIT_REACHED",
  "INVITATION_SEND_FAILED",
  "INVITATION_CANCEL_FAILED",
  "INVITATION_RESPONSE_FAILED",
  "INVALID_MEMBER_ROLE",
  "ORGANIZATION_MEMBER_NOT_FOUND",
  "MEMBER_ROLE_UPDATE_FORBIDDEN",
  "LAST_ORGANIZATION_OWNER",
  "MEMBER_ROLE_UPDATE_FAILED",
  "MEMBER_REMOVAL_FORBIDDEN",
  "MEMBER_REMOVAL_FAILED",
  "OWNER_ROLE_PROTECTED",
  "OWNERSHIP_TRANSFER_FORBIDDEN",
  "OWNERSHIP_TRANSFER_TARGET_INVALID",
  "OWNERSHIP_TRANSFER_FAILED",
] as const;

export type AuthErrorCode = (typeof authErrorCodes)[number];

export interface AuthError {
  readonly code: AuthErrorCode;
  readonly description: string;
}

const authErrorDescriptions: Readonly<Record<AuthErrorCode, string>> = {
  INVALID_REQUEST: "The authentication request is invalid",
  INVALID_NAME: "Enter a valid name",
  INVALID_EMAIL: "Enter a valid email address",
  INVALID_PASSWORD: "Password must contain between 8 and 128 characters",
  INVALID_CREDENTIALS: "The email address or password is incorrect",
  EMAIL_NOT_VERIFIED: "Verify your email address before signing in",
  INVALID_OTP: "The verification code is invalid or has already been used",
  OTP_EXPIRED: "The verification code has expired. Request another code",
  MFA_FAILED: "Authenticator verification failed. Check your code or use a recovery code",
  ACCOUNT_OWNS_ORGANIZATION: "Transfer ownership or delete your organizations before deleting your account",
  USER_EXISTS: "A user already exists with this email address",
  RATE_LIMITED: "Too many authentication attempts. Try again later",
  OAUTH_ACCESS_DENIED: "OAuth access was not granted",
  OAUTH_ACCOUNT_CONFLICT:
    "Sign in with the originally linked method before connecting this account",
  OAUTH_EMAIL_UNAVAILABLE: "The OAuth provider did not return a usable email address",
  OAUTH_PROVIDER_UNAVAILABLE: "The requested OAuth provider is unavailable",
  OAUTH_FAILED: "OAuth authentication could not be completed",
  SESSION_REQUIRED: "Sign in to continue",
  SESSION_EXPIRED: "Your session has expired. Sign in again",
  SESSION_NOT_FRESH: "Sign in again to perform this action",
  SESSION_FAILED: "The session operation could not be completed",
  AUTHENTICATION_FAILED: "Authentication could not be completed",
  INVALID_ORGANIZATION_NAME: "Enter a valid organization name",
  INVALID_ORGANIZATION_SLUG: "Use lowercase letters, numbers, and hyphens for the slug",
  ORGANIZATION_SLUG_TAKEN: "An organization already uses this slug",
  ORGANIZATION_SLUG_IMMUTABLE: "Organization slugs cannot be changed",
  ORGANIZATION_CREATION_FORBIDDEN: "You are not allowed to create an organization",
  ORGANIZATION_LIMIT_REACHED: "You have reached the organization limit",
  ORGANIZATION_CREATION_FAILED: "The organization could not be created",
  ORGANIZATION_NOT_FOUND: "The organization could not be found",
  ORGANIZATION_ACCESS_DENIED: "You do not have access to this organization",
  ORGANIZATION_SWITCH_FAILED: "The active organization could not be changed",
  ORGANIZATION_UPDATE_FORBIDDEN: "You are not allowed to update this organization",
  ORGANIZATION_UPDATE_FAILED: "The organization settings could not be updated",
  ORGANIZATION_DELETION_FORBIDDEN: "Only the organization owner can delete it",
  ORGANIZATION_CONFIRMATION_MISMATCH: "Enter the organization name exactly to confirm deletion",
  ORGANIZATION_DELETION_FAILED: "The organization could not be deleted. Try again or contact support",
  INVALID_INVITATION_EMAIL: "Enter a valid email address to invite",
  INVALID_INVITATION_ROLE: "Select a valid organization role",
  INVITATION_ALREADY_SENT: "A pending invitation already exists for this email address",
  ORGANIZATION_MEMBER_EXISTS: "This user is already a member of the organization",
  INVITATION_FORBIDDEN: "You are not allowed to manage organization invitations",
  INVITATION_NOT_FOUND: "The invitation is invalid, expired, or no longer available",
  INVITATION_RECIPIENT_MISMATCH: "This invitation belongs to a different email address",
  INVITATION_EMAIL_VERIFICATION_REQUIRED: "Verify your email address before responding",
  INVITATION_LIMIT_REACHED: "The organization invitation limit has been reached",
  INVITATION_SEND_FAILED: "The invitation could not be sent",
  INVITATION_CANCEL_FAILED: "The invitation could not be canceled",
  INVITATION_RESPONSE_FAILED: "The invitation response could not be completed",
  INVALID_MEMBER_ROLE: "Select a valid organization role",
  ORGANIZATION_MEMBER_NOT_FOUND: "The organization member could not be found",
  MEMBER_ROLE_UPDATE_FORBIDDEN: "You are not allowed to change this member's role",
  LAST_ORGANIZATION_OWNER: "The organization must keep at least one owner",
  MEMBER_ROLE_UPDATE_FAILED: "The member role could not be updated",
  MEMBER_REMOVAL_FORBIDDEN: "You are not allowed to remove this organization member",
  MEMBER_REMOVAL_FAILED: "The organization member could not be removed",
  OWNER_ROLE_PROTECTED: "Organization ownership can only be changed through ownership transfer",
  OWNERSHIP_TRANSFER_FORBIDDEN: "Only the current organization owner can transfer ownership",
  OWNERSHIP_TRANSFER_TARGET_INVALID: "Select another organization member as the new owner",
  OWNERSHIP_TRANSFER_FAILED: "Organization ownership could not be transferred",
};

export const authError = (code: AuthErrorCode): AuthError => ({
  code,
  description: authErrorDescriptions[code],
});

const betterAuthCodeMap: Readonly<Record<string, AuthErrorCode>> = {
  EMAIL_PASSWORD_DISABLED: "AUTHENTICATION_FAILED",
  EMAIL_PASSWORD_SIGN_UP_DISABLED: "AUTHENTICATION_FAILED",
  INVALID_EMAIL: "INVALID_EMAIL",
  INVALID_EMAIL_OR_PASSWORD: "INVALID_CREDENTIALS",
  INVALID_PASSWORD: "INVALID_PASSWORD",
  ACCOUNT_ALREADY_LINKED_TO_DIFFERENT_USER: "OAUTH_ACCOUNT_CONFLICT",
  ACCOUNT_NOT_LINKED: "OAUTH_ACCOUNT_CONFLICT",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  INVALID_OTP: "INVALID_OTP",
  OTP_EXPIRED: "OTP_EXPIRED",
  TOO_MANY_ATTEMPTS: "RATE_LIMITED",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "RATE_LIMITED",
  ACCOUNT_TEMPORARILY_LOCKED: "RATE_LIMITED",
  INVALID_CODE: "MFA_FAILED",
  INVALID_BACKUP_CODE: "MFA_FAILED",
  INVALID_TWO_FACTOR_COOKIE: "MFA_FAILED",
  ACCOUNT_OWNS_ORGANIZATION: "ACCOUNT_OWNS_ORGANIZATION",
  EMAIL_NOT_FOUND: "OAUTH_EMAIL_UNAVAILABLE",
  FAILED_TO_CREATE_SESSION: "SESSION_FAILED",
  FAILED_TO_GET_SESSION: "SESSION_FAILED",
  FAILED_TO_CREATE_USER: "OAUTH_FAILED",
  FAILED_TO_GET_USER_INFO: "OAUTH_FAILED",
  PASSWORD_TOO_LONG: "INVALID_PASSWORD",
  PASSWORD_TOO_SHORT: "INVALID_PASSWORD",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  SESSION_NOT_FRESH: "SESSION_NOT_FRESH",
  OAUTH_PROVIDER_NOT_FOUND: "OAUTH_PROVIDER_UNAVAILABLE",
  TOO_MANY_REQUESTS: "RATE_LIMITED",
  UNABLE_TO_LINK_ACCOUNT: "OAUTH_ACCOUNT_CONFLICT",
  UNAUTHORIZED: "SESSION_REQUIRED",
  USER_ALREADY_EXISTS: "USER_EXISTS",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "USER_EXISTS",
  ORGANIZATION_ALREADY_EXISTS: "ORGANIZATION_SLUG_TAKEN",
  ORGANIZATION_SLUG_ALREADY_TAKEN: "ORGANIZATION_SLUG_TAKEN",
  YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION: "ORGANIZATION_CREATION_FORBIDDEN",
  YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS: "ORGANIZATION_LIMIT_REACHED",
  ORGANIZATION_NOT_FOUND: "ORGANIZATION_NOT_FOUND",
  USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION: "ORGANIZATION_ACCESS_DENIED",
  YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION: "ORGANIZATION_ACCESS_DENIED",
  YOU_ARE_NOT_ALLOWED_TO_ACCESS_THIS_ORGANIZATION: "ORGANIZATION_ACCESS_DENIED",
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION: "ORGANIZATION_UPDATE_FORBIDDEN",
  USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION: "INVITATION_ALREADY_SENT",
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: "ORGANIZATION_MEMBER_EXISTS",
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION: "INVITATION_FORBIDDEN",
  YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION: "INVITATION_FORBIDDEN",
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE: "INVITATION_FORBIDDEN",
  INVITATION_NOT_FOUND: "INVITATION_NOT_FOUND",
  FAILED_TO_RETRIEVE_INVITATION: "INVITATION_NOT_FOUND",
  INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION: "INVITATION_NOT_FOUND",
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: "INVITATION_RECIPIENT_MISMATCH",
  EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION:
    "INVITATION_EMAIL_VERIFICATION_REQUIRED",
  EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION: "INVITATION_EMAIL_VERIFICATION_REQUIRED",
  INVITATION_LIMIT_REACHED: "INVITATION_LIMIT_REACHED",
  ROLE_NOT_FOUND: "INVALID_MEMBER_ROLE",
  MEMBER_NOT_FOUND: "ORGANIZATION_MEMBER_NOT_FOUND",
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER: "MEMBER_ROLE_UPDATE_FORBIDDEN",
  YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER: "MEMBER_REMOVAL_FORBIDDEN",
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER: "LAST_ORGANIZATION_OWNER",
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER: "LAST_ORGANIZATION_OWNER",
  OWNER_ROLE_PROTECTED: "OWNER_ROLE_PROTECTED",
  access_denied: "OAUTH_ACCESS_DENIED",
  account_already_linked_to_different_user: "OAUTH_ACCOUNT_CONFLICT",
  account_not_linked: "OAUTH_ACCOUNT_CONFLICT",
  email_does_not_match: "OAUTH_ACCOUNT_CONFLICT",
  email_not_found: "OAUTH_EMAIL_UNAVAILABLE",
  invalid_callback_request: "OAUTH_FAILED",
  invalid_code: "OAUTH_FAILED",
  no_code: "OAUTH_FAILED",
  state_invalid: "OAUTH_FAILED",
  state_mismatch: "OAUTH_FAILED",
  state_not_found: "OAUTH_FAILED",
  oauth_provider_not_found: "OAUTH_PROVIDER_UNAVAILABLE",
  unable_to_create_session: "OAUTH_FAILED",
  unable_to_create_user: "OAUTH_FAILED",
  unable_to_get_user_info: "OAUTH_FAILED",
  unable_to_link_account: "OAUTH_ACCOUNT_CONFLICT",
};

const authErrorCodeSet = new Set<string>(authErrorCodes);

const readStringProperty = (value: unknown, property: string): string | undefined => {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return undefined;
  }

  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
};

const readNumberProperty = (value: unknown, property: string): number | undefined => {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return undefined;
  }

  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "number" ? propertyValue : undefined;
};

const validationErrorCode = (message: string | undefined): AuthErrorCode => {
  if (message?.includes("body.email")) {
    return "INVALID_EMAIL";
  }

  if (message?.includes("body.password")) {
    return "INVALID_PASSWORD";
  }

  if (message?.includes("body.name")) {
    return message.includes("organization")
      ? "INVALID_ORGANIZATION_NAME"
      : "INVALID_NAME";
  }

  if (message?.includes("body.slug")) {
    return "INVALID_ORGANIZATION_SLUG";
  }

  return "INVALID_REQUEST";
};

export const toAuthError = (error: unknown, responseStatus?: number): AuthError => {
  const sourceCode = readStringProperty(error, "code");
  const status = readStringProperty(error, "status");
  const statusCode =
    readNumberProperty(error, "status") ??
    readNumberProperty(error, "statusCode") ??
    responseStatus;
  const code = sourceCode ? betterAuthCodeMap[sourceCode] : undefined;

  if (sourceCode && authErrorCodeSet.has(sourceCode)) {
    return authError(sourceCode as AuthErrorCode);
  }

  if (code) {
    return authError(code);
  }

  if (sourceCode === "VALIDATION_ERROR") {
    return authError(validationErrorCode(readStringProperty(error, "message")));
  }

  if (status === "TOO_MANY_REQUESTS" || statusCode === 429) {
    return authError("RATE_LIMITED");
  }

  if (statusCode === 401) {
    return authError("SESSION_REQUIRED");
  }

  return authError("AUTHENTICATION_FAILED");
};

export const toOrganizationSwitchError = (error: unknown): AuthError => {
  const normalized = toAuthError(error);

  return normalized.code === "AUTHENTICATION_FAILED"
    ? authError("ORGANIZATION_SWITCH_FAILED")
    : normalized;
};

export const toOrganizationUpdateError = (error: unknown): AuthError => {
  const normalized = toAuthError(error);

  return normalized.code === "AUTHENTICATION_FAILED"
    ? authError("ORGANIZATION_UPDATE_FAILED")
    : normalized;
};

export type OrganizationInvitationAction = "cancel" | "respond" | "send";

export const toOrganizationInvitationError = (
  error: unknown,
  action: OrganizationInvitationAction,
): AuthError => {
  const normalized = toAuthError(error);

  if (normalized.code === "INVALID_MEMBER_ROLE") {
    return authError("INVALID_INVITATION_ROLE");
  }

  if (normalized.code !== "AUTHENTICATION_FAILED") {
    return normalized;
  }

  if (action === "cancel") {
    return authError("INVITATION_CANCEL_FAILED");
  }

  if (action === "respond") {
    return authError("INVITATION_RESPONSE_FAILED");
  }

  return authError("INVITATION_SEND_FAILED");
};

export type OrganizationMemberAction = "remove" | "update-role";

export const toOrganizationMemberError = (
  error: unknown,
  action: OrganizationMemberAction,
): AuthError => {
  const normalized = toAuthError(error);

  if (normalized.code !== "AUTHENTICATION_FAILED") {
    return normalized;
  }

  return authError(
    action === "remove" ? "MEMBER_REMOVAL_FAILED" : "MEMBER_ROLE_UPDATE_FAILED",
  );
};

export type AuthResult<T> = { data: T; error: null } | { data: null; error: AuthError };

export const toAuthResult = <T>(result: { data?: T | null; error?: unknown }): AuthResult<T> => {
  if (result.error) {
    return { data: null, error: toAuthError(result.error) };
  }

  if (result.data !== null && result.data !== undefined) {
    return { data: result.data, error: null };
  }

  return { data: null, error: authError("AUTHENTICATION_FAILED") };
};
