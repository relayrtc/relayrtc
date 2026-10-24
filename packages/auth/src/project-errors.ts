export const projectErrorCodes = [
  "INVALID_PROJECT_INPUT",
  "PROJECT_NOT_FOUND",
  "PROJECT_ACCESS_DENIED",
  "PROJECT_MANAGEMENT_FORBIDDEN",
  "PROJECT_SLUG_TAKEN",
  "PROJECT_CREATION_FAILED",
  "PROJECT_UPDATE_FAILED",
  "PROJECT_CONFIRMATION_MISMATCH",
  "PROJECT_DELETION_FAILED",
  "INVALID_ENVIRONMENT_INPUT",
  "ENVIRONMENT_NOT_FOUND",
  "ENVIRONMENT_PROTECTED",
  "ENVIRONMENT_SLUG_TAKEN",
  "ENVIRONMENT_CREATION_FAILED",
  "ENVIRONMENT_UPDATE_FAILED",
  "ENVIRONMENT_DELETION_FAILED",
] as const

export type ProjectErrorCode = (typeof projectErrorCodes)[number]

export interface ProjectError {
  readonly code: ProjectErrorCode
  readonly description: string
}

const projectErrorDescriptions: Readonly<Record<ProjectErrorCode, string>> = {
  INVALID_PROJECT_INPUT: "Enter valid project information",
  PROJECT_NOT_FOUND: "The project could not be found",
  PROJECT_ACCESS_DENIED: "You do not have access to this project",
  PROJECT_MANAGEMENT_FORBIDDEN: "Only organization owners and admins can manage projects",
  PROJECT_SLUG_TAKEN: "A project in this organization already uses this slug",
  PROJECT_CREATION_FAILED: "The project could not be created",
  PROJECT_UPDATE_FAILED: "The project settings could not be updated",
  PROJECT_CONFIRMATION_MISMATCH: "Enter the project name exactly to confirm deletion",
  PROJECT_DELETION_FAILED: "The project could not be deleted",
  INVALID_ENVIRONMENT_INPUT: "Enter valid environment information",
  ENVIRONMENT_NOT_FOUND: "The environment could not be found",
  ENVIRONMENT_PROTECTED: "This environment is protected from deletion",
  ENVIRONMENT_SLUG_TAKEN: "An environment in this project already uses this slug",
  ENVIRONMENT_CREATION_FAILED: "The environment could not be created",
  ENVIRONMENT_UPDATE_FAILED: "The environment settings could not be updated",
  ENVIRONMENT_DELETION_FAILED: "The environment could not be deleted",
}

export const projectError = (code: ProjectErrorCode): ProjectError => ({
  code,
  description: projectErrorDescriptions[code],
})

export type ProjectResult<T> =
  | { data: T; error: null }
  | { data: null; error: ProjectError }
