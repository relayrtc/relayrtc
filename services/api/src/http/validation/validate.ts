import { ApiError } from "../errors/api-error.js";

interface RequestSchema<Output> {
  safeParse(value: unknown): { success: true; data: Output } | { success: false; error: unknown };
}

export const validate = <Output>(schema: RequestSchema<Output>, value: unknown): Output => {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "The request did not match the required API contract",
    );
  }

  return result.data;
};
