export class MediaEngineError extends Error {
  constructor(
    readonly code:
      | "CAPACITY_EXCEEDED"
      | "CONFLICT"
      | "FORBIDDEN"
      | "INVALID_REQUEST"
      | "NOT_FOUND"
      | "NOT_READY"
      | "UNSUPPORTED_OPERATION",
    message: string,
  ) {
    super(message);
    this.name = "MediaEngineError";
  }
}
